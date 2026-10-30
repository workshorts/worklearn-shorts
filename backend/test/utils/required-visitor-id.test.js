import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import test from 'node:test'
import express from 'express'
import { ApiError } from '../../src/errors.js'
import { errorHandler } from '../../src/middleware/errorHandler.js'
import { readOptionalVisitorId, readRequiredVisitorId } from '../../src/utils/visitor-id.js'

const visitorId = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const errorBody = {
  code: 'VALIDATION_ERROR', message: '입력값을 확인하세요.',
  fields: { visitorId: '방문자 ID는 올바른 UUID 형식으로 입력하세요.' },
}

function assertInvalid(req) {
  assert.throws(() => readRequiredVisitorId(req), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 400)
    assert.deepEqual({ code: error.code, message: error.message, fields: error.fields }, errorBody)
    return true
  })
}

test('required visitor IDs preserve the existing header contract and reject absence through the shared error boundary', { timeout: 30000 }, async t => {
  await t.test('query, body and cookie identities cannot replace a missing required header while optional reads remain nullable', () => {
    const req = Object.freeze({
      headers: Object.freeze({ cookie: 'visitorId=' + visitorId }),
      rawHeaders: Object.freeze(['Cookie', 'visitorId=' + visitorId]),
      query: Object.freeze({ visitorId }), body: Object.freeze({ visitorId }),
    })
    assertInvalid(req)
    assert.equal(readOptionalVisitorId(req), null)
    assertInvalid({ headers: Object.create(null), rawHeaders: [] })
  })

  await t.test('required headers share normalization without modifying the parsed or raw request values', () => {
    const upper = visitorId.toUpperCase()
    const req = Object.freeze({
      headers: Object.freeze({ 'x-visitor-id': upper }),
      rawHeaders: Object.freeze(['x-ViSiToR-iD', upper]),
    })
    assert.equal(readRequiredVisitorId(req), visitorId)
    assert.equal(readRequiredVisitorId(req), readOptionalVisitorId(req))
    assert.equal(req.headers['x-visitor-id'], upper)
    assert.equal(req.rawHeaders[1], upper)
  })

  await t.test('a collapsed duplicate or invalid supplied value is rejected without coercion or fallback', () => {
    assertInvalid({
      headers: { 'x-visitor-id': visitorId },
      rawHeaders: ['X-Visitor-Id', visitorId, 'x-visitor-id', visitorId],
    })
    let conversions = 0
    const value = { toString() { conversions += 1; return visitorId } }
    for (const supplied of [undefined, null, '', ' ', [visitorId], value, 'private-invalid-visitor']) {
      assertInvalid({ headers: { 'x-visitor-id': supplied }, rawHeaders: ['X-Visitor-Id', supplied],
        query: { visitorId }, body: { visitorId } })
    }
    assert.equal(conversions, 0)
  })

  // Exercise real Node headers and the production error handler without adding the view API yet.
  const app = express()
  app.post('/required', (req, res) => res.json({ visitorId: readRequiredVisitorId(req) }))
  app.get('/optional', (req, res) => res.json({ visitorId: readOptionalVisitorId(req) }))
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  await once(server, 'listening')

  function request(path, headers = {}, method = 'POST') {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: server.address().port, path, method, headers, agent: false }, res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { body += chunk })
        res.on('error', reject)
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }) } catch (error) { reject(error) }
        })
      })
      req.setTimeout(5000, () => req.destroy(new Error('Test request timed out')))
      req.on('error', reject)
      req.end()
    })
  }

  await t.test('real POST requests reject missing, blank, malformed and duplicate headers with the fixed public 400', async () => {
    for (const headers of [{}, { Cookie: 'visitorId=' + visitorId }, { 'X-Visitor-Id': '' },
      { 'X-Visitor-Id': 'private-invalid-visitor' }, { 'X-Visitor-Id': [visitorId, visitorId] }]) {
      assert.deepEqual(await request('/required?visitorId=' + visitorId, headers), { status: 400, body: errorBody })
    }
  })

  await t.test('real POST requests need no JSON body for a valid required header and optional GET still accepts absence', async () => {
    assert.deepEqual(await request('/required', { 'x-ViSiToR-iD': visitorId.toUpperCase() }),
      { status: 200, body: { visitorId } })
    assert.deepEqual(await request('/optional', {}, 'GET'), { status: 200, body: { visitorId: null } })
  })
})
