import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']
const password = '1234'
const newestFirst = (a, b) => a.createdAt === b.createdAt ? b.id - a.id : a.createdAt > b.createdAt ? -1 : 1

test('comment GET preserves its complete pagination contract across real creation, deletion and parent removal', { timeout: 30000 }, async t => {
  const previous = { COMMENT_CREATE_MAX: process.env.COMMENT_CREATE_MAX, COMMENT_DELETE_MAX: process.env.COMMENT_DELETE_MAX }
  Object.assign(process.env, { COMMENT_CREATE_MAX: '100', COMMENT_DELETE_MAX: '100' })
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const db = getDb()
  for (const id of [1, 2, 3]) {
    db.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(id, 'Contract parent ' + id, 'unused-path')
  }
  const expected = []
  const other = []
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  async function create(videoId, index) {
    const body = { nickname: ' Author ' + index, password, content: ' Comment ' + index + '\n😀' }
    const response = await request(`/api/videos/${videoId}/comments`, { method: 'POST', body })
    assert.equal(response.status, 201)
    assert.equal(response.json.videoId, videoId)
    assert.equal(response.json.nickname, body.nickname)
    assert.equal(response.json.content, body.content)
    return response.json
  }
  async function page(videoId, query, expectedPage, limit, collection) {
    const response = await request(`/api/videos/${videoId}/comments${query}`, {
      headers: { 'X-Visitor-Id': 'unused-invalid-visitor', Origin: 'https://other.example.test' },
      cookie: 'admin_session=unused-invalid-cookie',
    })
    assert.equal(response.status, 200)
    const sorted = [...collection].sort(newestFirst)
    assert.deepEqual(response.json, { data: sorted.slice((expectedPage - 1) * limit, expectedPage * limit),
      page: expectedPage, limit, total: collection.length })
    assert.deepEqual(Object.keys(response.json), ['data', 'page', 'limit', 'total'])
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.equal(response.headers['retry-after'], undefined)
    for (const comment of response.json.data) {
      assert.deepEqual(Object.keys(comment), ['id', 'videoId', 'nickname', 'content', 'createdAt'])
      assert.ok(Number.isSafeInteger(comment.id) && comment.id > 0)
      assert.equal(comment.videoId, videoId)
      assert.equal(typeof comment.createdAt, 'string')
    }
    assert.doesNotMatch(response.text, /password_hash|passwordHash|scrypt\$/)
    return response.json.data
  }
  async function traverse(collection) {
    const before = snapshot()
    for (const limit of [1, 20, 50]) {
      const combined = []
      const pages = Math.ceil(collection.length / limit)
      for (let number = 1; number <= pages + 1; number++) {
        // Omit limit=20 to verify the default on every page, not just page one.
        const query = `?page=${number}` + (limit === 20 ? '' : `&limit=${limit}`)
        combined.push(...await page(1, query, number, limit, collection))
      }
      assert.deepEqual(combined, [...collection].sort(newestFirst))
      assert.equal(new Set(combined.map(comment => comment.id)).size, collection.length)
    }
    await page(2, '', 1, 20, other)
    await page(3, '', 1, 20, [])
    assert.equal(db.isTransaction, false)
    assert.deepEqual(snapshot(), before)
  }

  await t.test('all pages cover more than fifty committed comments exactly once with full totals and isolated parents', async () => {
    await page(1, '', 1, 20, [])
    for (let index = 0; index < 51; index++) expected.push(await create(1, index))
    for (let index = 0; index < 2; index++) other.push(await create(2, 'other-' + index))
    await traverse(expected)
  })

  await t.test('deleting newest, page-boundary and oldest comments reflows pages and later creation restores the fifty-item boundary', async () => {
    const sorted = [...expected].sort(newestFirst)
    for (const comment of [sorted[0], sorted[19], sorted.at(-1)]) {
      const response = await request(`/api/comments/${comment.id}`, { method: 'DELETE', body: { password } })
      assert.equal(response.status, 204)
      assert.equal(response.text, '')
      expected.splice(expected.findIndex(item => item.id === comment.id), 1)
    }
    assert.equal(expected.length, 48)
    await traverse(expected)
    for (let index = 0; index < 3; index++) expected.push(await create(1, 'new-' + index))
    assert.equal(expected.length, 51)
    await traverse(expected)
  })

  await t.test('an existing empty video remains 200 while a removed parent is 404 and malformed pagination still takes priority', async () => {
    db.prepare('DELETE FROM videos WHERE id = ?').run(1)
    const before = snapshot()
    const missing = await request('/api/videos/1/comments')
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.json, { code: 'NOT_FOUND', message: '영상을 찾을 수 없습니다.', fields: {} })
    const invalid = await request('/api/videos/1/comments?page=0')
    assert.equal(invalid.status, 400)
    assert.equal(invalid.json.code, 'VALIDATION_ERROR')
    assert.deepEqual(Object.keys(invalid.json.fields), ['page'])
    await page(2, '', 1, 20, other)
    await page(3, '', 1, 20, [])
    assert.deepEqual(snapshot(), before)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  })
})
