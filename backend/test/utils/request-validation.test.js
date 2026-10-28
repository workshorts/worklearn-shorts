import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { after, afterEach, before, mock, test } from 'node:test'
import express from 'express'
import { errorHandler } from '../../src/middleware/errorHandler.js'
import { parseLimit, parsePage } from '../../src/utils/pagination.js'
import { parseResourceId } from '../../src/utils/resource-id.js'
import { readOptionalVisitorId } from '../../src/utils/visitor-id.js'

const visitorId = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const fieldMessages = {
  id: 'ID는 1 이상 9007199254740991 이하의 정수로 입력하세요.',
  page: '페이지는 1 이상 9007199254740991 이하의 정수로 입력하세요.',
  limit: '페이지당 항목 수는 1 이상 50 이하의 정수로 입력하세요.',
  visitorId: '방문자 ID는 올바른 UUID 형식으로 입력하세요.',
}

let server
let accepted = 0
let errorLog

before(async () => {
  errorLog = mock.method(console, 'error', () => {})
  // Exercise the production parsers and error boundary without implementing video endpoints.
  const app = express()
  app.get('/_validation/list', (req, res) => {
    const page = parsePage(req.query.page)
    const limit = parseLimit(req.query.limit)
    const visitorId = readOptionalVisitorId(req)
    accepted += 1
    res.json({ page, limit, visitorId })
  })
  app.get('/_validation/detail/:id', (req, res) => {
    const id = parseResourceId(req.params.id)
    const visitorId = readOptionalVisitorId(req)
    accepted += 1
    res.json({ id, visitorId })
  })
  app.use(errorHandler)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
})

afterEach(() => {
  assert.equal(errorLog.mock.callCount(), 0, 'Expected validation failures must not enter the internal-error log')
})

after(async () => {
  try {
    if (server?.listening) {
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  } finally {
    mock.restoreAll()
  }
})

function request(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port,
      method: 'GET', path, headers, agent: false }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('error', reject)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }) }
        catch (error) { reject(error) }
      })
    })
    req.setTimeout(5000, () => req.destroy(new Error('Test HTTP request timed out')))
    req.on('error', reject)
    req.end()
  })
}

async function expectInvalid(path, field, headers) {
  const before = accepted
  const response = await request(path, headers)
  assert.equal(response.status, 400, path)
  assert.deepEqual(response.body, {
    code: 'VALIDATION_ERROR', message: '입력값을 확인하세요.', fields: { [field]: fieldMessages[field] },
  }, path)
  assert.match(response.headers['content-type'], /^application\/json\b/)
  assert.equal(response.headers['set-cookie'], undefined)
  assert.equal(accepted, before, 'Invalid requests must stop before the handler continuation')
}

test('HTTP validation defaults omitted page, limit and visitor values while preserving independent numeric options', async () => {
  for (const [query, expected] of [
    ['', { page: 1, limit: 20, visitorId: null }],
    ['?page=2', { page: 2, limit: 20, visitorId: null }],
    ['?limit=50', { page: 1, limit: 50, visitorId: null }],
    ['?page=%30%30%32&limit=%30%30%31', { page: 2, limit: 1, visitorId: null }],
  ]) {
    const response = await request('/_validation/list' + query)
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, expected)
  }
})

test('HTTP validation preserves exact numeric boundaries and decoded leading zeros without computing an offset', async () => {
  for (const [input, expected] of [['1', 1], ['%30%30%31', 1], ['9007199254740991', Number.MAX_SAFE_INTEGER]]) {
    const response = await request('/_validation/detail/' + input)
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { id: expected, visitorId: null })
  }
  for (const limit of [1, 50]) {
    const response = await request(`/_validation/list?page=9007199254740991&limit=${limit}`)
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { page: Number.MAX_SAFE_INTEGER, limit, visitorId: null })
  }
})

test('HTTP validation classifies decoded invalid resource IDs as fixed field errors before continuation', async () => {
  for (const input of ['0', '000', '-1', '1.5', '1.0', 'abc', '1abc', '1e2', '+1', '0x10',
    '9007199254740992', '9007199254740993', ' ', ' 1', '1\n', '1/2', '１', '\0',
    'private-id C:/private/app.db SELECT private_hash']) {
    await expectInvalid('/_validation/detail/' + encodeURIComponent(input), 'id')
  }
})

test('HTTP validation rejects blank, nonpositive, fractional, nonnumeric and unsafe page query values', async () => {
  for (const input of ['', '0', '-1', '1.5', '1.0', 'abc', '1abc', '1e2', '+1', '0x10',
    '9007199254740992', '9007199254740993', ' ', '1\n', '１', '\0',
    'private-page C:/private/app.db SELECT private_hash']) {
    await expectInvalid('/_validation/list?page=' + encodeURIComponent(input), 'page')
  }
  await expectInvalid('/_validation/list?page', 'page')
  await expectInvalid('/_validation/list?page=+1', 'page')
})

test('HTTP validation rejects blank, noninteger and out-of-range limit query values without clamping', async () => {
  for (const input of ['', '0', '-1', '1.5', '1.0', 'abc', '1abc', '1e2', '+1', '0x10', '51', '100',
    '9007199254740991', '9007199254740992', ' ', '20\n', '２０', '\0',
    'private-limit C:/private/app.db SELECT private_hash']) {
    await expectInvalid('/_validation/list?limit=' + encodeURIComponent(input), 'limit')
  }
  await expectInvalid('/_validation/list?limit', 'limit')
  await expectInvalid('/_validation/list?limit=+1', 'limit')
})

test('HTTP validation rejects repeated page and limit parameters even when their values are identical', async () => {
  for (const [query, field] of [
    ['page=1&page=1', 'page'], ['page=1&page=2', 'page'], ['page=&page=1', 'page'],
    ['limit=20&limit=20', 'limit'], ['limit=20&limit=50', 'limit'], ['limit=20&limit=', 'limit'],
  ]) {
    await expectInvalid('/_validation/list?' + query, field)
  }
})

test('HTTP validation normalizes one visitor UUID consistently for list and detail requests', async () => {
  for (const input of [visitorId.toUpperCase(), '00000000-0000-1000-8000-000000000001',
    'aabbccdd-eeff-8abc-bdef-012345abcdef']) {
    for (const path of ['/_validation/list', '/_validation/detail/1']) {
      const response = await request(path, { 'x-ViSiToR-iD': input })
      assert.equal(response.status, 200)
      assert.deepEqual(response.body, path.endsWith('/1')
        ? { id: 1, visitorId: input.toLowerCase() }
        : { page: 1, limit: 20, visitorId: input.toLowerCase() })
    }
  }
})

test('HTTP validation rejects invalid optional visitor values on both request shapes with no input disclosure', async () => {
  for (const value of ['', 'invalid-private-visitor', '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff', visitorId.replace('-4abc-', '-0abc-'),
    visitorId.replace('-8def-', '-7def-'), visitorId.replaceAll('-', ''), `urn:uuid:${visitorId}`,
    `{${visitorId}}`, visitorId.slice(1), visitorId + '0', visitorId.replace('eeff', 'ee f'),
    visitorId + ', ' + visitorId, 'C:/private/app.db SELECT private_hash']) {
    for (const path of ['/_validation/list', '/_validation/detail/1']) {
      await expectInvalid(path, 'visitorId', { 'X-Visitor-Id': value })
    }
  }
})

test('HTTP validation rejects raw duplicate visitor headers through the shared error boundary', async () => {
  for (const second of [visitorId, visitorId.toUpperCase(), '', 'invalid-private-visitor']) {
    for (const path of ['/_validation/list', '/_validation/detail/1']) {
      await expectInvalid(path, 'visitorId', [
        'Host', 'localhost', 'X-Visitor-Id', visitorId, 'x-VISITOR-id', second,
      ])
    }
  }
})

test('HTTP validation reports controlled fields for multiple invalid inputs without depending on validation order', async () => {
  for (const [path, allowed] of [
    ['/_validation/list?page=0&limit=51', ['page', 'limit', 'visitorId']],
    ['/_validation/detail/0', ['id', 'visitorId']],
  ]) {
    const before = accepted
    const response = await request(path, { 'X-Visitor-Id': 'private-invalid-visitor' })
    assert.equal(response.status, 400)
    assert.deepEqual(Object.keys(response.body).sort(), ['code', 'fields', 'message'])
    assert.equal(response.body.code, 'VALIDATION_ERROR')
    assert.equal(response.body.message, '입력값을 확인하세요.')
    assert.ok(Object.keys(response.body.fields).length > 0)
    for (const [field, message] of Object.entries(response.body.fields)) {
      assert.ok(allowed.includes(field))
      assert.equal(message, fieldMessages[field])
    }
    assert.equal(accepted, before)
  }
})
