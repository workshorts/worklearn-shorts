import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { verifyPassword } from '../../src/lib/password.js'
import { startAuthServer } from '../helpers/auth-server.js'

const valid = { nickname: 'a', password: '1234', content: 'a' }
const fields = [
  ['nickname', 1, 20, '닉네임은 1~20자로 입력하세요.'],
  ['password', 4, 30, '비밀번호는 4~30자로 입력하세요.'],
  ['content', 1, 500, '내용은 1~500자로 입력하세요.'],
]
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('comment POST honors each field boundary through storage and exact error statuses', { timeout: 30000 }, async t => {
  const settings = { COMMENT_CREATE_MAX: '19', COMMENT_CREATE_WINDOW_SECONDS: '600' }
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
  db.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
    .run(1, 'Boundary contract target', 'unused-path')
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  const initial = snapshot()
  const post = (body, id = 1, headers) => request(`/api/videos/${id}/comments`, { method: 'POST', body, headers })
  const createdIds = new Set()

  function jsonResponse(response, status) {
    assert.equal(response.status, status)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    if (status !== 429) assert.equal(response.headers['retry-after'], undefined)
    assert.equal(db.isTransaction, false)
  }

  for (const [field, minimum, maximum, message] of fields) {
    await t.test(`${field} accepts inclusive ASCII, Korean and supplementary boundaries and rejects adjacent lengths`, async () => {
      for (const character of ['x', '한', '😀']) {
        for (const length of [minimum - 1, maximum + 1]) {
          const before = snapshot()
          const response = await post({ ...valid, [field]: character.repeat(length) })
          jsonResponse(response, 400)
          assert.deepEqual(response.json, {
            code: 'VALIDATION_ERROR', message: '입력값을 확인하세요.', fields: { [field]: message },
          })
          assert.deepEqual(snapshot(), before)
        }
        for (const length of [minimum, maximum]) {
          const body = { ...valid, [field]: character.repeat(length) }
          const response = await post(body)
          jsonResponse(response, 201)
          assert.deepEqual(Object.keys(response.json), ['id', 'videoId', 'nickname', 'content', 'createdAt'])
          const { id, createdAt } = response.json
          assert.ok(Number.isSafeInteger(id) && id > 0)
          assert.equal(createdIds.has(id), false)
          createdIds.add(id)
          assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
          assert.deepEqual(response.json, { id, videoId: 1, nickname: body.nickname, content: body.content, createdAt })
          const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(id)
          assert.deepEqual({ id: row.id, videoId: row.video_id, nickname: row.nickname,
            content: row.content, createdAt: row.created_at }, response.json)
          assert.equal(verifyPassword(body.password, row.password_hash), true)
          assert.equal(db.prepare('SELECT COUNT(*) AS total FROM comments').get().total, createdIds.size)
        }
      }
    })
  }

  await t.test('415 and malformed JSON do not consume quota, missing parents return 404 and exhausted quota returns 429', async () => {
    assert.equal(createdIds.size, 18)
    const before = snapshot()
    const unsupported = await post(valid, 1, { 'Content-Type': 'text/plain' })
    jsonResponse(unsupported, 415)
    assert.deepEqual(unsupported.json, {
      code: 'UNSUPPORTED_MEDIA_TYPE', message: '지원하지 않는 요청 또는 파일 형식입니다.', fields: {},
    })
    const malformed = await post('{bad')
    jsonResponse(malformed, 400)
    assert.deepEqual(malformed.json, { code: 'INVALID_JSON', message: 'JSON 형식이 올바르지 않습니다.', fields: {} })
    const missing = await post(valid, 999)
    jsonResponse(missing, 404)
    assert.deepEqual(missing.json, { code: 'NOT_FOUND', message: '영상을 찾을 수 없습니다.', fields: {} })
    const blocked = await post(valid)
    jsonResponse(blocked, 429)
    assert.deepEqual(blocked.json, {
      code: 'RATE_LIMITED', message: '시도가 너무 많습니다. 잠시 후 다시 시도하세요.', fields: {},
    })
    assert.match(blocked.headers['retry-after'], /^[1-9]\d*$/)
    assert.ok(Number(blocked.headers['retry-after']) <= 600)
    assert.deepEqual(snapshot(), before)
  })

  const final = snapshot()
  for (const table of tables.filter(table => table !== 'comments' && table !== 'sqlite_sequence')) {
    assert.deepEqual(final.rows[table], initial.rows[table])
  }
  assert.deepEqual(final.schema, initial.schema)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})
