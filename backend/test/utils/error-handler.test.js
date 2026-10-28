import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { ApiError, errors } from '../../src/errors.js'
import { errorHandler } from '../../src/middleware/errorHandler.js'

const internalBody = { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} }

function respond(error) {
  const response = {
    headersSent: false,
    set(headers) { this.headers = headers; return this },
    status(status) { this.statusCode = status; return this },
    json(body) { this.body = body; return this },
  }
  errorHandler(error, { body: { password: 'private-password' } }, response, () => {
    assert.fail('An unsent error response must be handled by the shared boundary')
  })
  return response
}

test('the error adapter preserves application status, public fields and trusted response headers', t => {
  const log = t.mock.method(console, 'error', () => {})
  for (const error of [errors.validation({ id: 'Invalid ID' }), errors.invalidJson(),
    errors.authRequired(), errors.invalidCredentials(), errors.originForbidden(), errors.notFound(),
    errors.conflict('CONFLICT', 'Conflict'), errors.fileTooLarge(), errors.unsupportedMediaType(),
    errors.rateLimited(17)]) {
    error.cause = new Error('private-cause')
    error.stack = 'private-stack'
    error.extra = 'private-extra'
    const response = respond(error)
    assert.equal(response.statusCode, error.status)
    assert.deepEqual(response.headers, error.headers)
    assert.deepEqual(response.body, { code: error.code, message: error.message, fields: error.fields })
    assert.deepEqual(Object.keys(response.body).sort(), ['code', 'fields', 'message'])
  }
  assert.deepEqual(respond(errors.rateLimited(17)).headers, { 'Retry-After': '17' })
  assert.equal(log.mock.callCount(), 0)
})

test('the error adapter ignores native status and public-looking fields and logs only a fixed identifier', t => {
  const log = t.mock.method(console, 'error', () => {})
  const privateDetails = { status: 404, code: 'PRIVATE_CODE', message: 'C:/private/app.db',
    fields: { password: 'private-hash' }, headers: { 'Set-Cookie': 'private-session' } }
  const native = Object.assign(new Error('SELECT private_hash FROM admins'), privateDetails)
  const aggregate = new AggregateError([native], 'private-aggregate', { cause: native })
  const values = [native, aggregate, privateDetails, null, undefined, 'private-string', 123, false,
    Object.assign(new Error('private-parser-spoof'), { type: 'entity.parse.failed', status: 400 })]
  for (const error of values) {
    const response = respond(error)
    assert.equal(response.statusCode, 500)
    assert.deepEqual(response.body, internalBody)
    assert.equal(response.headers, undefined)
  }
  assert.equal(log.mock.callCount(), values.length)
  for (const call of log.mock.calls) assert.deepEqual(call.arguments, ['INTERNAL_ERROR'])
})

test('the error adapter maps JSON parser syntax failures to a fixed response without echoing the body', t => {
  const log = t.mock.method(console, 'error', () => {})
  const error = Object.assign(new SyntaxError('private-json-body'), {
    type: 'entity.parse.failed', status: 400, body: 'private-json-body',
  })
  const response = respond(error)
  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.body, {
    code: 'INVALID_JSON', message: 'JSON 형식이 올바르지 않습니다.', fields: {},
  })
  assert.equal(log.mock.callCount(), 0)
  assert.deepEqual(respond(new SyntaxError('private-code-error')).body, internalBody)
  assert.deepEqual(log.mock.calls[0].arguments, ['INTERNAL_ERROR'])
})

test('the error adapter hides a real SQLite failure rather than treating it as a missing resource', t => {
  const log = t.mock.method(console, 'error', () => {})
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  let failure
  try { db.prepare('SELECT private_hash FROM private_admin_table').all() } catch (error) { failure = error }
  assert.ok(failure instanceof Error)
  assert.match(failure.message, /private_admin_table/)
  const response = respond(failure)
  assert.equal(response.statusCode, 500)
  assert.deepEqual(response.body, internalBody)
  assert.deepEqual(log.mock.calls[0].arguments, ['INTERNAL_ERROR'])
})

test('the error adapter closes a response whose headers were sent without writing or forwarding private details', t => {
  const log = t.mock.method(console, 'error', () => {})
  let closed = 0
  const response = {
    headersSent: true,
    destroy() { closed += 1 },
    status() { assert.fail('Cannot change an already-sent status') },
    json() { assert.fail('Cannot send a second JSON response') },
  }
  errorHandler(new Error('private-stream-failure'), {}, response, () => assert.fail('Must not forward raw errors'))
  assert.equal(closed, 1)
  assert.deepEqual(log.mock.calls[0].arguments, ['INTERNAL_ERROR'])
  assert.equal(errorHandler.length, 4)
  assert.ok(errors.notFound() instanceof ApiError)
})
