import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { validateCommentCreateRequest } from '../../src/middleware/validateCommentCreateRequest.js'
import { validateCommentDeleteRequest } from '../../src/middleware/validateCommentDeleteRequest.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const messages = {
  id: 'ID는 1 이상 9007199254740991 이하의 정수로 입력하세요.',
  password: '비밀번호는 4~30자로 입력하세요.',
}
const invalidPasswords = [undefined, null, false, 1234, [], ['1234'], {}, '', '123',
  'x'.repeat(31), '😀'.repeat(3), '😀'.repeat(31), 'ok\0secret', '\ud800abc', 'abc\udfff',
  { toString() { assert.fail('Passwords must never be coerced') } }]
const invalidIds = [undefined, null, 1, false, [], {}, '', '0', '-1', '+1', '1.5', '1e2',
  '0x10', 'abc', '１', ' 1', '1 ', '1\n', '9007199254740992']
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function reject(body, field = 'password', params = { id: '1' }) {
  const res = { locals: { existing: 'preserved' } }
  assert.throws(() => validateCommentDeleteRequest({ params, body }, res,
    () => assert.fail('Invalid deletion input must stop before the continuation')), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 400)
    assert.equal(error.code, 'VALIDATION_ERROR')
    assert.equal(error.message, '입력값을 확인하세요.')
    assert.deepEqual(error.fields, { [field]: messages[field] })
    return true
  })
  assert.deepEqual(res.locals, { existing: 'preserved' })
}

test('deletion accepts safe parent-independent IDs and exact passwords at ASCII and Unicode boundaries', () => {
  for (const [id, expectedId] of [['0001', 1], [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER]]) {
    for (const password of ['1234', 'x'.repeat(30), '한'.repeat(30), '😀'.repeat(4), '😀'.repeat(30),
      '    ', ' 12 ', ' e\u0301 Mixed ', 'a\nbc']) {
      const body = Object.freeze({ password, get unrelated() { assert.fail('Only the declared password may be read') } })
      const req = Object.freeze({ params: Object.freeze({ id }), body })
      const res = { locals: { existing: 'preserved' } }
      let calls = 0
      validateCommentDeleteRequest(req, res, () => { calls += 1 })
      assert.equal(calls, 1)
      assert.deepEqual(res.locals, { existing: 'preserved', commentDeleteRequest: { id: expectedId, password } })
      assert.equal(req.body, body)
    }
  }
})

test('invalid comment IDs take priority over password errors and publish no partial deletion input', () => {
  for (const id of invalidIds) reject({}, 'id', { id })
})

test('creation and deletion reject the same invalid passwords and deletion requires a direct body field', () => {
  for (const password of invalidPasswords) {
    reject({ password })
    assert.throws(() => validateCommentCreateRequest({ params: { id: '1' },
      body: { nickname: 'Author', content: 'Comment', password } }, { locals: {} },
    () => assert.fail('Creation must reject the same invalid password')), error =>
      error instanceof ApiError && error.status === 400 && error.fields.password === messages.password)
  }
  for (const body of [undefined, null, false, 1234, '1234', [], [{ password: '1234' }], {}, Object.create({ password: '1234' })]) {
    reject(body)
  }
})

test('registered comment DELETE rejects bad input before any database work without removing existing comments', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const db = getDb()
  const fixture = insertMinimalFixture(db)
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  const before = snapshot()
  async function rejectsWithoutSql(subtest, cases) {
    const prepare = db.prepare.bind(db)
    const exec = db.exec.bind(db)
    const prepared = subtest.mock.method(db, 'prepare', (...args) => prepare(...args))
    const executed = subtest.mock.method(db, 'exec', (...args) => exec(...args))
    const log = subtest.mock.method(console, 'error', () => {})
    try {
      for (const { id = fixture.commentId, body, headers, status, code, fields = {} } of cases) {
        const response = await request(`/api/comments/${encodeURIComponent(id)}`, { method: 'DELETE', body, headers })
        assert.equal(response.status, status)
        const message = code === 'VALIDATION_ERROR' ? '입력값을 확인하세요.' :
          code === 'INVALID_JSON' ? 'JSON 형식이 올바르지 않습니다.' : '지원하지 않는 요청 또는 파일 형식입니다.'
        assert.deepEqual(response.json, { code, message, fields })
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
  }

  await t.test('malformed IDs return fields.id before checking a missing password or comment', async subtest => {
    const ids = ['0', '-1', '+1', '1.5', '1e2', '0x10', 'abc', '１', ' 1', '1 ', '1\n', '9007199254740992']
    await rejectsWithoutSql(subtest, ids.map(id => ({ id, body: {}, status: 400, code: 'VALIDATION_ERROR', fields: { id: messages.id } })))
  })

  await t.test('missing, non-string and invalid passwords return fields.password for existing and absent IDs', async subtest => {
    const bodies = [{}, [], undefined, ...invalidPasswords.slice(0, -1).map(password => ({ password }))]
    await rejectsWithoutSql(subtest, [fixture.commentId, Number.MAX_SAFE_INTEGER].flatMap(id => bodies.map(body => ({
      id, body, headers: { 'Content-Type': 'application/json' }, status: 400, code: 'VALIDATION_ERROR', fields: { password: messages.password },
    }))))
  })

  await t.test('malformed JSON and unsupported parser encodings retain the fixed shared 400 and 415 errors', async subtest => {
    await rejectsWithoutSql(subtest, [
      ...['{bad', '{"password":"private-value"', '[1,}', 'null'].map(body => ({ body, status: 400, code: 'INVALID_JSON' })),
      ...[
        { 'Content-Type': 'application/json; charset=iso-8859-1' },
        { 'Content-Type': 'application/json; charset=utf-private' },
        { 'Content-Type': 'application/json', 'Content-Encoding': 'private-encoding' },
      ].map(headers => ({ headers, body: { password: '1234' }, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' })),
    ])
  })

  await t.test('missing and unsupported media types including JSON lookalikes are rejected with 415', async subtest => {
    await rejectsWithoutSql(subtest, [
      { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
      ...['text/plain', 'application/x-www-form-urlencoded', 'application/xml', 'application/jsonx',
        'application/json-patch+json', 'application/problem+json'].map(type => ({ body: '{"password":"1234"}',
        headers: { 'Content-Type': type }, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' })),
    ])
  })
})
