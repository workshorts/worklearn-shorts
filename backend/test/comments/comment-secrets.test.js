import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { hashPassword } from '../../src/lib/password.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']
const password = 'pw-"\\\n한-secret-7'
const retainedPassword = 'keep-private-123'
const wrongPassword = 'wrong-private-123'
const invalidPassword = 'invalid-private-'.repeat(3)
const parserSecret = 'parser-private-only-9'
const nativeSecret = 'native-private-only-8'

test('public comment responses and console output exclude credentials and nested native error details', { timeout: 30000 }, async t => {
  const settings = { COMMENT_CREATE_MAX: '3', COMMENT_CREATE_WINDOW_SECONDS: '2',
    COMMENT_DELETE_MAX: '3', COMMENT_DELETE_WINDOW_SECONDS: '2' }
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
  const retainedHash = hashPassword(retainedPassword)
  db.prepare('UPDATE comments SET password_hash = ? WHERE id = ?').run(retainedHash, fixture.commentId)
  const secrets = new Set([password, retainedPassword, wrongPassword, invalidPassword, parserSecret, nativeSecret])
  function rememberHash(hash) {
    secrets.add(hash)
    secrets.add(hash.split('$')[4])
    secrets.add(hash.split('$')[5])
  }
  rememberHash(retainedHash)
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  // Let startup warnings finish before observing application logging in this isolated process.
  await new Promise(resolve => setImmediate(resolve))
  const levels = ['error', 'warn', 'log', 'info', 'debug', 'trace']
  const logs = Object.fromEntries(levels.map(level => [level, t.mock.method(console, level, () => {})]))
  const body = { nickname: 'Author', password, content: 'Public password reset guide' }
  const post = (id = fixture.videoId, candidate = body, headers) =>
    request(`/api/videos/${id}/comments`, { method: 'POST', body: candidate, headers })
  const remove = (id = fixture.commentId, candidate = { password: retainedPassword }, headers) =>
    request(`/api/comments/${id}`, { method: 'DELETE', body: candidate, headers })

  function strings(value) {
    if (typeof value === 'string') return [value]
    if (value === null || typeof value !== 'object') return []
    return Object.entries(value).flatMap(([key, nested]) => [key, ...strings(nested)])
  }
  function privateResponse(response, status, code) {
    assert.equal(response.status, status)
    if (code !== undefined) assert.equal(response.json.code, code)
    // Inspect parsed strings as well as wire text so JSON escaping cannot hide leaked values.
    for (const value of [response.text, ...strings(response.json), ...strings(response.headers)]) {
      for (const secret of secrets) assert.equal(value.includes(secret), false, 'A private value reached an HTTP response')
    }
    assert.equal(response.headers['set-cookie'], undefined)
    assert.equal(db.isTransaction, false)
    return response
  }
  function expectedLogs(internalErrors) {
    for (const level of levels) {
      assert.deepEqual(logs[level].mock.calls.map(call => call.arguments),
        level === 'error' ? Array.from({ length: internalErrors }, () => ['INTERNAL_ERROR']) : [])
    }
  }

  await t.test('successful POST, GET and DELETE expose only public fields and never log either stored hash', async () => {
    const created = await post(fixture.videoId, { ...body, password_hash: retainedHash,
      passwordHash: retainedHash, debug: { password: retainedPassword } })
    assert.equal(created.status, 201)
    const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(created.json.id)
    rememberHash(row.password_hash)
    assert.notEqual(row.password_hash, retainedHash)
    privateResponse(created, 201)
    assert.deepEqual(Object.keys(created.json), ['id', 'videoId', 'nickname', 'content', 'createdAt'])
    assert.equal(created.json.content, body.content)
    const list = privateResponse(await request(`/api/videos/${fixture.videoId}/comments`), 200)
    assert.equal(list.json.total, 2)
    for (const comment of list.json.data) {
      assert.deepEqual(Object.keys(comment), ['id', 'videoId', 'nickname', 'content', 'createdAt'])
    }
    const deleted = privateResponse(await remove(created.json.id, { password }), 204)
    assert.equal(deleted.text, '')
    assert.equal(deleted.json, null)
    expectedLogs(0)
  })

  await t.test('validation, parser, format, password, missing-target and quota errors never echo private inputs or log requests', async () => {
    now += 2000
    const before = snapshot()
    const malformed = `{"password":"${parserSecret}"`
    privateResponse(await post(fixture.videoId, { ...body, password: invalidPassword }), 400, 'VALIDATION_ERROR')
    privateResponse(await remove(fixture.commentId, { password: invalidPassword }), 400, 'VALIDATION_ERROR')
    privateResponse(await post(fixture.videoId, malformed), 400, 'INVALID_JSON')
    privateResponse(await remove(fixture.commentId, malformed), 400, 'INVALID_JSON')
    privateResponse(await post(fixture.videoId, body, { 'Content-Type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE')
    privateResponse(await remove(fixture.commentId, { password: retainedPassword }, { 'Content-Type': 'text/plain' }),
      415, 'UNSUPPORTED_MEDIA_TYPE')
    for (let attempt = 0; attempt < 3; attempt++) privateResponse(await post(999), 404, 'NOT_FOUND')
    privateResponse(await post(), 429, 'RATE_LIMITED')
    privateResponse(await remove(fixture.commentId, { password: wrongPassword }), 403, 'COMMENT_PASSWORD_MISMATCH')
    privateResponse(await remove(999), 404, 'NOT_FOUND')
    privateResponse(await remove(fixture.commentId, { password: wrongPassword }), 403, 'COMMENT_PASSWORD_MISMATCH')
    privateResponse(await remove(), 429, 'RATE_LIMITED')
    assert.deepEqual(snapshot(), before)
    expectedLogs(0)
  })

  await t.test('GET, POST and DELETE native failures expose a fixed 500 and log only INTERNAL_ERROR despite private error properties', async subtest => {
    now += 2000
    const before = snapshot()
    const fault = Object.assign(new Error(`${nativeSecret}: ${password}: ${retainedHash}`, {
      cause: new Error(`${retainedPassword}: ${retainedHash}`),
    }), { status: 400, code: 'VALIDATION_ERROR', password, password_hash: retainedHash,
      fields: { password: retainedPassword }, headers: { 'X-Private-Detail': nativeSecret } })
    const prepared = subtest.mock.method(db, 'prepare', () => { throw fault })
    try {
      for (const operation of [() => request(`/api/videos/${fixture.videoId}/comments`), () => post(), () => remove()]) {
        const response = privateResponse(await operation(), 500, 'INTERNAL_ERROR')
        assert.deepEqual(response.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
        assert.equal(response.headers['x-private-detail'], undefined)
      }
      assert.equal(prepared.mock.callCount(), 3)
    } finally {
      prepared.mock.restore()
    }
    assert.deepEqual(snapshot(), before)
    privateResponse(await request(`/api/videos/${fixture.videoId}/comments`), 200)
    expectedLogs(3)
  })
})
