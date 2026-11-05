import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { hashPassword } from '../../src/lib/password.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']
const missingError = { code: 'NOT_FOUND', message: '댓글을 찾을 수 없습니다.', fields: {} }

test('comment DELETE accepts passwords created at Unicode boundaries and preserves every rejected target', { timeout: 30000 }, async t => {
  const settings = { COMMENT_CREATE_MAX: '6', COMMENT_CREATE_WINDOW_SECONDS: '600',
    COMMENT_DELETE_MAX: '19', COMMENT_DELETE_WINDOW_SECONDS: '600' }
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
  db.prepare('UPDATE comments SET password_hash = ? WHERE id = ?').run(hashPassword('keep'), fixture.commentId)
  const otherVideo = db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Other contract target', 'unused-path').lastInsertRowid
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  const initial = snapshot()
  const remove = (id, body, headers) => request(`/api/comments/${id}`, { method: 'DELETE', body, headers })

  function errorResponse(response, status, error) {
    assert.equal(response.status, status)
    assert.deepEqual(response.json, error)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    if (status !== 429) assert.equal(response.headers['retry-after'], undefined)
    assert.equal(db.isTransaction, false)
  }

  for (const [name, character] of [['ASCII', 'x'], ['Korean', '한'], ['supplementary Unicode', '😀']]) {
    await t.test(`${name} passwords of four and thirty characters delete only their own committed comments`, async () => {
      for (const length of [4, 30]) {
        const password = character.repeat(length)
        const videoId = length === 4 ? fixture.videoId : otherVideo
        const created = await request(`/api/videos/${videoId}/comments`, {
          method: 'POST', body: { nickname: 'Author', password, content: `${name} ${length}` },
        })
        assert.equal(created.status, 201)
        assert.equal(created.json.videoId, videoId)
        const id = created.json.id
        const before = snapshot()

        for (const invalidLength of [3, 31]) {
          errorResponse(await remove(id, { password: character.repeat(invalidLength) }), 400, {
            code: 'VALIDATION_ERROR', message: '입력값을 확인하세요.',
            fields: { password: '비밀번호는 4~30자로 입력하세요.' },
          })
          assert.deepEqual(snapshot(), before)
        }
        const wrongPassword = character.repeat(length - 1) + 'z'
        errorResponse(await remove(id, { password: wrongPassword }), 403, {
          code: 'COMMENT_PASSWORD_MISMATCH', message: '비밀번호가 일치하지 않습니다.', fields: {},
        })
        assert.deepEqual(snapshot(), before)

        const removed = await remove(id, { password })
        assert.equal(removed.status, 204)
        assert.equal(removed.text, '')
        assert.equal(removed.json, null)
        for (const header of ['content-type', 'content-length', 'transfer-encoding', 'set-cookie', 'retry-after']) {
          assert.equal(removed.headers[header], undefined)
        }
        assert.equal(db.isTransaction, false)
        const after = snapshot()
        assert.deepEqual(after.rows.comments, before.rows.comments.filter(row => row.id !== id))
        for (const table of tables.filter(table => table !== 'comments')) {
          assert.deepEqual(after.rows[table], before.rows[table])
        }
        assert.deepEqual(after.schema, before.schema)
        errorResponse(await remove(id, { password }), 404, missingError)
        assert.deepEqual(snapshot(), after)
      }
    })
  }

  await t.test('format errors consume no attempts, a missing comment returns 404 and the next attempt is blocked without deletion', async () => {
    const before = snapshot()
    errorResponse(await remove(fixture.commentId, { password: 'keep' }, { 'Content-Type': 'text/plain' }), 415, {
      code: 'UNSUPPORTED_MEDIA_TYPE', message: '지원하지 않는 요청 또는 파일 형식입니다.', fields: {},
    })
    errorResponse(await remove(fixture.commentId, '{bad'), 400, {
      code: 'INVALID_JSON', message: 'JSON 형식이 올바르지 않습니다.', fields: {},
    })
    errorResponse(await remove(999, { password: 'keep' }), 404, missingError)
    const blocked = await remove(fixture.commentId, { password: 'keep' })
    errorResponse(blocked, 429, {
      code: 'RATE_LIMITED', message: '시도가 너무 많습니다. 잠시 후 다시 시도하세요.', fields: {},
    })
    assert.match(blocked.headers['retry-after'], /^[1-9]\d*$/)
    assert.ok(Number(blocked.headers['retry-after']) <= 600)
    assert.deepEqual(snapshot(), before)
  })

  const final = snapshot()
  for (const table of tables.filter(table => table !== 'sqlite_sequence')) {
    assert.deepEqual(final.rows[table], initial.rows[table])
  }
  assert.deepEqual(final.schema, initial.schema)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})
