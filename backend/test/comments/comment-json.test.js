import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { requireJson } from '../../src/middleware/requireJson.js'
import { startAuthServer } from '../helpers/auth-server.js'

const unsupported = { code: 'UNSUPPORTED_MEDIA_TYPE', message: '지원하지 않는 요청 또는 파일 형식입니다.', fields: {} }
const invalidJson = { code: 'INVALID_JSON', message: 'JSON 형식이 올바르지 않습니다.', fields: {} }
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('the shared JSON guard accepts exact case-insensitive JSON types and charset parameters without requiring a body', () => {
  for (const type of ['application/json', 'APPLICATION/JSON', 'application/json; charset=utf-8', 'Application/Json ; charset=UTF-8']) {
    const req = Object.freeze({ headers: Object.freeze({ 'content-type': type }) })
    const res = Object.freeze({ locals: Object.freeze({ existing: 'preserved' }) })
    let calls = 0
    requireJson(req, res, error => { assert.equal(error, undefined); calls += 1 })
    assert.equal(calls, 1)
  }
})

test('the shared JSON guard rejects missing, non-string and prefix lookalike media types with the fixed 415', () => {
  for (const type of [undefined, null, '', [], ['application/json'], 1, 'text/plain', 'application/jsonx',
    'application/json-patch+json', 'application/json, text/plain', 'application/problem+json']) {
    let calls = 0
    requireJson({ headers: { 'content-type': type } }, {}, error => {
      calls += 1
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 415)
      assert.deepEqual({ code: error.code, message: error.message, fields: error.fields }, unsupported)
      assert.deepEqual(error.headers, {})
    })
    assert.equal(calls, 1)
  }
})

test('comment request format failures use shared public errors before any database work', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const id = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)').run('Comment parent', 'unused-path').lastInsertRowid
  const path = '/api/videos/' + id + '/comments'
  const payload = '{"nickname":"Author","password":"private-password","content":"Comment"}'
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  const baseline = snapshot()
  async function rejectWithoutSql(subtest, cases, status, expected) {
    const prepare = database.prepare.bind(database)
    const exec = database.exec.bind(database)
    const prepared = subtest.mock.method(database, 'prepare', (...args) => prepare(...args))
    const executed = subtest.mock.method(database, 'exec', (...args) => exec(...args))
    const log = subtest.mock.method(console, 'error', () => {})
    try {
      for (const options of cases) {
        const response = await request(path, { method: 'POST', ...options })
        assert.equal(response.status, status)
        assert.deepEqual(response.json, expected)
        assert.equal(response.headers['set-cookie'], undefined)
        assert.match(response.headers['content-type'], /^application\/json\b/)
      }
      assert.equal(prepared.mock.callCount(), 0)
      assert.equal(executed.mock.callCount(), 0)
      assert.equal(log.mock.callCount(), 0)
    } finally {
      prepared.mock.restore()
      executed.mock.restore()
    }
    assert.equal(database.isTransaction, false)
    assert.deepEqual(snapshot(), baseline)
  }

  await t.test('missing and unsupported Content-Type values return 415 including JSON prefix lookalikes', async subtest => {
    const types = ['text/plain', 'application/x-www-form-urlencoded', 'application/xml', 'multipart/form-data',
      'application/jsonx', 'application/json-patch+json', 'application/problem+json']
    await rejectWithoutSql(subtest, [{}, { body: Buffer.from(payload) },
      ...types.map(type => ({ body: payload, headers: { 'Content-Type': type } }))], 415, unsupported)
  })

  await t.test('malformed JSON receives the fixed 400 without echoing private body text', async subtest => {
    await rejectWithoutSql(subtest, ['{"password":"private-password"', '{"nickname":}', '[1,}', '{bad'].map(body => ({ body })), 400, invalidJson)
  })

  await t.test('unsupported parser charsets and content encodings return the fixed 415 rather than an internal error', async subtest => {
    await rejectWithoutSql(subtest, [
      { body: payload, headers: { 'Content-Type': 'application/json; charset=iso-8859-1' } },
      { body: payload, headers: { 'Content-Type': 'application/json; charset=utf-private' } },
      { body: payload, headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'private-encoding' } },
    ], 415, unsupported)
  })

  await t.test('the public comment GET still works without a JSON header and issues no authentication cookie', async () => {
    const response = await request(path)
    assert.equal(response.status, 200)
    assert.deepEqual(response.json, { data: [], page: 1, limit: 20, total: 0 })
    assert.equal(response.headers['set-cookie'], undefined)
  })

  await t.test('database errors resembling parser failures remain internal errors and a later read recovers', async subtest => {
    const log = subtest.mock.method(console, 'error', () => {})
    for (const type of ['charset.unsupported', 'encoding.unsupported']) {
      const fault = subtest.mock.method(database, 'prepare', () => {
        throw Object.assign(new Error('private-database-details'), { status: 415, type })
      })
      try {
        const response = await request(path)
        assert.equal(response.status, 500)
        assert.deepEqual(response.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
      } finally {
        fault.mock.restore()
      }
      assert.equal(database.isTransaction, false)
      const response = await request(path)
      assert.equal(response.status, 200)
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR'], ['INTERNAL_ERROR']])
  })
  assert.deepEqual(snapshot(), baseline)
})
