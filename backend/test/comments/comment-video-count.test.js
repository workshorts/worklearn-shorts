import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { hashPassword } from '../../src/lib/password.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']
const body = { nickname: 'Author', password: '1234', content: 'Repeated comment' }

test('Video.commentCount follows committed public comment mutations across lists, details and tag filters', { timeout: 30000 }, async t => {
  const settings = { COMMENT_CREATE_MAX: '100', COMMENT_CREATE_WINDOW_SECONDS: '600',
    COMMENT_DELETE_MAX: '100', COMMENT_DELETE_WINDOW_SECONDS: '600' }
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]))
  Object.assign(process.env, settings)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const db = getDb()
  const fixture = insertMinimalFixture(db)
  const mediaPath = 'videos/10000000-0000-4000-8000-000000000001.mp4'
  db.prepare('UPDATE videos SET video_path = ? WHERE id = ?').run(mediaPath, fixture.videoId)
  db.prepare('UPDATE comments SET password_hash = ? WHERE id = ?').run(hashPassword(body.password), fixture.commentId)
  const insertVideo = db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
  const control = insertVideo.run('Control', mediaPath).lastInsertRowid
  const empty = insertVideo.run('Initially empty', mediaPath).lastInsertRowid
  db.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(control, fixture.tagId)
  const extraTag = db.prepare('INSERT INTO tags (name) VALUES (?)').run('Second tag').lastInsertRowid
  db.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(fixture.videoId, extraTag)
  for (const table of ['video_views', 'video_likes']) {
    db.prepare(`INSERT INTO ${table} (video_id, visitor_id) VALUES (?, ?)`)
      .run(fixture.videoId, '00000000-0000-4000-8000-000000000002')
  }
  const ids = [fixture.videoId, control, empty]
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  const initial = snapshot()
  const stableVideos = new Map()
  const targetComments = []
  let emptyComment
  const post = (id = fixture.videoId, candidate = body) =>
    request(`/api/videos/${id}/comments`, { method: 'POST', body: candidate })
  const remove = (id, password = body.password) =>
    request(`/api/comments/${id}`, { method: 'DELETE', body: { password } })

  async function counts(expected) {
    const before = snapshot()
    const actual = new Map(ids.map((id, index) => {
      const count = db.prepare('SELECT COUNT(*) AS total FROM comments WHERE video_id = ?').get(id).total
      assert.equal(count, expected[index])
      return [id, count]
    }))
    for (const table of tables.filter(table => table !== 'comments' && table !== 'sqlite_sequence')) {
      assert.deepEqual(before.rows[table], initial.rows[table])
    }
    assert.deepEqual(before.schema, initial.schema)
    for (const visitor of [null, fixture.visitorId]) {
      const headers = visitor === null ? {} : { 'X-Visitor-Id': visitor }
      async function get(path) {
        const response = await request(path, { headers })
        assert.equal(response.status, 200, path)
        assert.equal(response.headers['set-cookie'], undefined)
        assert.equal(db.isTransaction, false)
        return response.json
      }
      function video(item) {
        assert.equal(item.commentCount, actual.get(item.id))
        assert.ok(Number.isSafeInteger(item.commentCount) && item.commentCount >= 0)
        const { commentCount, ...unchanged } = item
        const key = `${visitor}:${item.id}`
        if (!stableVideos.has(key)) stableVideos.set(key, unchanged)
        else assert.deepEqual(unchanged, stableVideos.get(key))
      }
      for (const [suffix, matching, limit] of [
        ['', [...ids].reverse(), 2], [`&tagId=${fixture.tagId}`, [control, fixture.videoId], 1],
      ]) {
        const collected = []
        for (let page = 1; page <= Math.ceil(matching.length / limit) + 1; page++) {
          const result = await get(`/api/videos?page=${page}&limit=${limit}${suffix}`)
          assert.equal(result.total, matching.length)
          assert.deepEqual(result.data.map(item => item.id), matching.slice((page - 1) * limit, page * limit))
          result.data.forEach(video)
          collected.push(...result.data.map(item => item.id))
        }
        assert.deepEqual(collected, matching)
      }
      for (const id of ids) {
        video(await get(`/api/videos/${id}`))
        const comments = await get(`/api/videos/${id}/comments?limit=1`)
        assert.equal(comments.total, actual.get(id))
        assert.equal(comments.data.length, Math.min(actual.get(id), 1))
      }
    }
    assert.deepEqual(snapshot(), before)
  }

  await t.test('repeat POSTs increase the exact target count and reads agree across visitors and pagination', async () => {
    await counts([1, 0, 0])
    for (const expected of [[2, 0, 0], [3, 0, 0]]) {
      const created = await post()
      assert.equal(created.status, 201)
      targetComments.push(created.json.id)
      await counts(expected)
    }
    assert.notEqual(targetComments[0], targetComments[1])
    assert.equal((await post(control)).status, 201)
    await counts([3, 1, 0])
    const created = await post(empty)
    assert.equal(created.status, 201)
    emptyComment = created.json.id
    await counts([3, 1, 1])
  })

  await t.test('rejected and rolled-back POST and DELETE requests leave every visible count unchanged', async subtest => {
    const before = snapshot()
    assert.equal((await post(fixture.videoId, { ...body, content: '' })).status, 400)
    assert.equal((await remove(targetComments[0], 'wrong-password')).status, 403)
    assert.deepEqual(snapshot(), before)
    await counts([3, 1, 1])
    const log = subtest.mock.method(console, 'error', () => {})
    for (const operation of [() => post(), () => remove(targetComments[0])]) {
      const exec = db.exec.bind(db)
      let reached = false
      const fault = subtest.mock.method(db, 'exec', sql => {
        if (sql === 'COMMIT') { reached = true; throw new Error('Injected comment count commit failure') }
        return exec(sql)
      })
      try {
        const response = await operation()
        assert.equal(response.status, 500)
        assert.deepEqual(response.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
        assert.equal(reached, true)
      } finally {
        fault.mock.restore()
      }
      assert.deepEqual(snapshot(), before)
      await counts([3, 1, 1])
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR'], ['INTERNAL_ERROR']])
  })

  await t.test('DELETE reaches zero, repeated deletion cannot decrement again and later creation refreshes all reads', async () => {
    for (const [id, expected] of [
      [targetComments[0], [2, 1, 1]], [targetComments[1], [1, 1, 1]],
      [fixture.commentId, [0, 1, 1]], [emptyComment, [0, 1, 0]],
    ]) {
      const response = await remove(id)
      assert.equal(response.status, 204)
      assert.equal(response.text, '')
      await counts(expected)
    }
    const before = snapshot()
    assert.equal((await remove(fixture.commentId)).status, 404)
    assert.deepEqual(snapshot(), before)
    await counts([0, 1, 0])
    const recreated = await post()
    assert.equal(recreated.status, 201)
    await counts([1, 1, 0])
    assert.equal((await remove(recreated.json.id)).status, 204)
    await counts([0, 1, 0])
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  })
})
