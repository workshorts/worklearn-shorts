import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'
import { errors } from '../../src/errors.js'
import { errorHandler } from '../../src/middleware/errorHandler.js'
import { startAuthServer } from '../helpers/auth-server.js'

const sqliteWarningPattern = /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time(?:\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\))?$/

function assertInternalErrorLog(calls) {
  // Ignore only the known runtime warning; unexpected application logs must still fail.
  const applicationCalls = calls.filter(args => {
    if (args.length !== 1 || typeof args[0] !== 'string') return true
    return sqliteWarningPattern.exec(args[0])?.[0] !== args[0]
  })
  assert.deepEqual(applicationCalls, [['INTERNAL_ERROR']])
}

test('error log assertions tolerate only the SQLite runtime warning and still reject leaked or extra logs', () => {
  const warning = '(node:123) ExperimentalWarning: SQLite is an experimental feature and might change at any time'
  const hint = '\n(Use `node --trace-warnings ...` to show where the warning was created)'
  const internal = ['INTERNAL_ERROR']
  assertInternalErrorLog([internal])
  assertInternalErrorLog([[warning], internal])
  assertInternalErrorLog([internal, [warning + hint]])
  for (const calls of [[], [[warning]], [internal, internal],
    [internal, [new Error('SELECT private_hash at C:/private/app.db')]],
    [internal, ['private-session']], [['INTERNAL_ERROR', 'private-hash']],
    [internal, [warning, 'private-hash']], [internal, [warning + '\nprivate-hash']],
    [internal, [warning + hint + '\n']],
    [internal, ['(node:123) DeprecationWarning: another warning']]]) {
    assert.throws(() => assertInternalErrorLog(calls), { code: 'ERR_ASSERTION' })
  }
})

test('the shared adapter handles synchronous throws, next errors and rejected async routes over HTTP', async t => {
  const log = t.mock.method(console, 'error', () => {})
  const app = express()
  app.get('/sync', () => { throw errors.validation({ page: 'Invalid page' }) })
  app.get('/next', (req, res, next) => next(errors.rateLimited(23)))
  app.get('/async', async () => { throw new Error('private-async-hash-and-path') })
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const sync = await fetch(base + '/sync')
  assert.equal(sync.status, 400)
  assert.deepEqual(await sync.json(), {
    code: 'VALIDATION_ERROR', message: '입력값을 확인하세요.', fields: { page: 'Invalid page' },
  })
  const next = await fetch(base + '/next')
  assert.equal(next.status, 429)
  assert.equal(next.headers.get('retry-after'), '23')
  assert.deepEqual(await next.json(), { code: 'RATE_LIMITED', message: '시도가 너무 많습니다. 잠시 후 다시 시도하세요.', fields: {} })
  const rejected = await fetch(base + '/async')
  assert.equal(rejected.status, 500)
  assert.deepEqual(await rejected.json(), { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
  assertInternalErrorLog(log.mock.calls.map(call => call.arguments))
})

test('the production app uses the adapter for JSON, not-found and database failures and recovers normally', async t => {
  const { request, login, getDb } = await startAuthServer(t)
  const log = t.mock.method(console, 'error', () => {})
  const malformed = await request('/api/admin/login', { method: 'POST', body: '{"private-password":' })
  assert.equal(malformed.status, 400)
  assert.deepEqual(malformed.json, { code: 'INVALID_JSON', message: 'JSON 형식이 올바르지 않습니다.', fields: {} })
  const missing = await request('/api/missing-private-path')
  assert.equal(missing.status, 404)
  assert.deepEqual(missing.json, { code: 'NOT_FOUND', message: '요청한 대상을 찾을 수 없습니다.', fields: {} })
  const db = getDb()
  const prepare = t.mock.method(db, 'prepare', () => {
    throw new Error('SELECT private_hash FROM admins at C:/private/app.db; private-session')
  })
  try {
    const failure = await login()
    assert.equal(failure.res.status, 500)
    assert.deepEqual(failure.res.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
    assert.equal(failure.res.headers['set-cookie'], undefined)
  } finally {
    prepare.mock.restore()
  }
  assertInternalErrorLog(log.mock.calls.map(call => call.arguments))
  const recovered = await login()
  assert.equal(recovered.res.status, 200)
  assert.ok(recovered.cookie.startsWith('admin_session='))
})
