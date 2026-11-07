import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { validateVideoQuizRequest } from '../../src/middleware/validateVideoQuizRequest.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const idMessage = 'ID는 1 이상 9007199254740991 이하의 정수로 입력하세요.'
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('quiz validation publishes exact safe IDs, normalizes leading zeros and preserves the request', () => {
  for (const [input, expected] of [['1', 1], ['0007', 7], ['9007199254740991', Number.MAX_SAFE_INTEGER]]) {
    const req = Object.freeze({ params: Object.freeze({ id: input }) })
    const res = { locals: { existing: 'preserved' } }
    let calls = 0
    validateVideoQuizRequest(req, res, () => { calls += 1 })
    assert.equal(calls, 1)
    assert.deepEqual(res.locals, { existing: 'preserved', videoQuizRequest: { id: expected } })
    assert.equal(req.params.id, input)
  }
})

test('invalid quiz IDs stop before continuation without coercion or partial context', () => {
  for (const id of [undefined, null, false, 1, [], ['1'], {}, '', '0', '-1', '+1', '1.5', '1e2',
    '0x10', 'abc', '１', ' 1', '1 ', '1\n', '1\0', '1/2', '9007199254740992', '9'.repeat(400),
    { toString() { assert.fail('Resource IDs must not be coerced') } }]) {
    const res = { locals: { existing: 'preserved' } }
    assert.throws(() => validateVideoQuizRequest({ params: { id } }, res,
      () => assert.fail('Invalid input must not continue')), error => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 400)
      assert.deepEqual({ code: error.code, message: error.message, fields: error.fields }, {
        code: 'VALIDATION_ERROR', message: '입력값을 확인하세요.', fields: { id: idMessage },
      })
      return true
    })
    assert.deepEqual(res.locals, { existing: 'preserved' })
  }
})

test('public quiz validation never reads visitor headers, cookies, query, body or authentication', () => {
  const req = { params: { id: '0007' } }
  for (const field of ['headers', 'rawHeaders', 'cookies', 'query', 'body', 'user', 'get']) {
    Object.defineProperty(req, field, { get() { assert.fail(`Quiz validation must not read ${field}`) } })
  }
  const res = { locals: {} }
  let calls = 0
  validateVideoQuizRequest(req, res, () => { calls += 1 })
  assert.equal(calls, 1)
  assert.deepEqual(res.locals, { videoQuizRequest: { id: 7 } })
})

test('the registered quiz path returns safe 400 errors before SQL and preserves all data', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const db = getDb()
  insertMinimalFixture(db)
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  const before = snapshot()
  const prepared = t.mock.method(db, 'prepare', () => assert.fail('Invalid quiz IDs must not query storage'))
  const executed = t.mock.method(db, 'exec', () => assert.fail('Invalid quiz IDs must not start a transaction'))
  const log = t.mock.method(console, 'error', () => {})
  try {
    for (const id of ['0', '-1', '+1', '1.5', '1e2', '0x10', 'abc', '１', ' 1', '1 ',
      '1\n', '1\0', '1/2', '9007199254740992', '9'.repeat(400)]) {
      const response = await request(`/api/videos/${encodeURIComponent(id)}/quiz?id=1&visitorId=ignored`, {
        headers: { 'X-Visitor-Id': 'invalid-unused-visitor', Origin: 'https://other.example.test' },
        cookie: 'admin_session=invalid-unused-session',
      })
      assert.equal(response.status, 400)
      assert.deepEqual(response.json, {
        code: 'VALIDATION_ERROR', message: '입력값을 확인하세요.', fields: { id: idMessage },
      })
      assert.match(response.headers['content-type'], /^application\/json\b/)
      assert.equal(response.headers['set-cookie'], undefined)
      assert.equal(response.headers['retry-after'], undefined)
    }
    assert.equal(prepared.mock.callCount(), 0)
    assert.equal(executed.mock.callCount(), 0)
    assert.equal(log.mock.callCount(), 0)
  } finally {
    prepared.mock.restore()
    executed.mock.restore()
    log.mock.restore()
  }
  assert.equal(db.isTransaction, false)
  assert.deepEqual(snapshot(), before)
})
