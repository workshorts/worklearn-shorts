import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { after, before, test } from 'node:test'
import { ApiError } from '../../src/errors.js'
import { readOptionalVisitorId } from '../../src/utils/visitor-id.js'

const visitorId = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const errorBody = {
  code: 'VALIDATION_ERROR',
  message: '입력값을 확인하세요.',
  fields: { visitorId: '방문자 ID는 올바른 UUID 형식으로 입력하세요.' },
}

function assertInvalid(req) {
  assert.throws(() => readOptionalVisitorId(req), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 400)
    assert.deepEqual({ code: error.code, message: error.message, fields: error.fields }, errorBody)
    assert.deepEqual(error.headers, {})
    return true
  })
}

test('optional visitor IDs return null only for an absent header and leave the request untouched', () => {
  const req = Object.freeze({
    headers: Object.freeze({ cookie: `visitorId=${visitorId}`, 'x-other': visitorId }),
    rawHeaders: Object.freeze(['Cookie', `visitorId=${visitorId}`, 'X-Other', visitorId]),
    query: Object.freeze({ visitorId }),
    body: Object.freeze({ visitorId }),
  })
  assert.equal(readOptionalVisitorId(req), null)
  assert.equal(readOptionalVisitorId(req), null)
  assert.equal(readOptionalVisitorId({ headers: Object.create(null), rawHeaders: [] }), null)
})

test('optional visitor IDs normalize a single header without mutating its parsed or raw value', () => {
  for (const name of ['X-Visitor-Id', 'x-visitor-id', 'X-VISITOR-ID', 'x-ViSiToR-iD']) {
    const upper = visitorId.toUpperCase()
    const req = Object.freeze({
      headers: Object.freeze({ 'x-visitor-id': upper }),
      rawHeaders: Object.freeze(['Host', 'localhost', name, upper, 'X-Other', 'value']),
    })
    assert.equal(readOptionalVisitorId(req), visitorId)
    assert.equal(req.headers['x-visitor-id'], upper)
    assert.equal(req.rawHeaders[3], upper)
  }
})

test('optional visitor IDs reject every present invalid value without coercion or fallback', () => {
  let conversions = 0
  const object = { toString() { conversions += 1; return visitorId } }
  for (const value of [undefined, null, '', ' ', '\t', 1, false, object, [visitorId],
    new String(visitorId), ` ${visitorId}`, `${visitorId}\n`, `${visitorId}, ${visitorId}`,
    'SELECT private_hash FROM admins', 'C:/private/secret.db']) {
    assertInvalid({ headers: { 'x-visitor-id': value }, rawHeaders: ['X-Visitor-Id', value] })
  }
  assert.equal(conversions, 0)
})

test('optional visitor IDs reject raw duplicates even if parsed headers retain one valid value', () => {
  for (const value of [visitorId, visitorId.toUpperCase(), '', 'invalid']) {
    assertInvalid({
      headers: { 'x-visitor-id': visitorId },
      rawHeaders: ['X-Visitor-Id', visitorId, 'Host', 'localhost', 'x-VISITOR-id', value],
    })
  }
})

test('optional visitor IDs do not treat a present undefined or dropped parsed value as absence', () => {
  assertInvalid({ headers: { 'x-visitor-id': undefined }, rawHeaders: [] })
  assertInvalid({ headers: {}, rawHeaders: ['X-Visitor-Id', visitorId] })
})

let server
before(async () => {
  // This isolated HTTP harness exercises Node header parsing without a database or public API route.
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    try {
      res.end(JSON.stringify({ visitorId: readOptionalVisitorId(req) }))
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      res.statusCode = error.status
      res.end(JSON.stringify({ code: error.code, message: error.message, fields: error.fields }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
})

after(async () => {
  if (!server?.listening) return
  server.closeAllConnections()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

function request(headers = {}, path = '/') {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port,
      path, method: 'GET', headers, agent: false }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('error', reject)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }) } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

test('HTTP requests may omit visitor headers even with visitor-like query and cookie values', async () => {
  assert.deepEqual(await request({ Cookie: `visitorId=${visitorId}` }, `/?visitorId=${visitorId}`),
    { status: 200, body: { visitorId: null } })
})

test('HTTP requests accept a single mixed-case header name and normalize an uppercase UUID', async () => {
  assert.deepEqual(await request({ 'x-ViSiToR-iD': visitorId.toUpperCase() }),
    { status: 200, body: { visitorId } })
})

test('HTTP requests reject blank, malformed and comma-joined visitor header values with fixed errors', async () => {
  for (const value of ['', 'invalid-private-value', `${visitorId}, ${visitorId}`]) {
    assert.deepEqual(await request({ 'X-Visitor-Id': value }), { status: 400, body: errorBody })
  }
})

test('HTTP requests reject identical and different duplicate visitor headers regardless of name casing', async () => {
  for (const second of [visitorId, visitorId.toUpperCase(), '', 'invalid-private-value']) {
    const headers = ['Host', 'localhost', 'X-Visitor-Id', visitorId, 'x-VISITOR-id', second]
    assert.deepEqual(await request(headers), { status: 400, body: errorBody })
  }
})
