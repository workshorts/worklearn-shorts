import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { validateVideoViewRequest } from '../../src/middleware/validateVideoViewRequest.js'
import { startAuthServer } from '../helpers/auth-server.js'

const visitorId = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const fields = {
  id: 'ID는 1 이상 9007199254740991 이하의 정수로 입력하세요.',
  visitorId: '방문자 ID는 올바른 UUID 형식으로 입력하세요.',
}
const errorBody = field => ({ code: 'VALIDATION_ERROR', message: '입력값을 확인하세요.', fields: { [field]: fields[field] } })

function input(id, visitor) {
  return Object.freeze({
    params: Object.freeze({ id }),
    headers: Object.freeze(visitor === undefined ? {} : { 'x-visitor-id': visitor }),
    rawHeaders: Object.freeze(visitor === undefined ? [] : ['X-Visitor-Id', visitor]),
  })
}

test('view validation passes normalized path and visitor identity together without mutating the request', () => {
  for (const [id, expectedId] of [['0001', 1], ['9007199254740991', Number.MAX_SAFE_INTEGER]]) {
    const req = input(id, visitorId.toUpperCase())
    const res = { locals: { existing: 'preserved' } }
    let calls = 0
    validateVideoViewRequest(req, res, () => { calls += 1 })
    assert.equal(calls, 1)
    assert.deepEqual(res.locals, { existing: 'preserved', videoViewRequest: { id: expectedId, visitorId } })
    assert.equal(req.params.id, id)
    assert.equal(req.headers['x-visitor-id'], visitorId.toUpperCase())
  }
})

test('view validation stops before continuation and publishes no partial input for invalid IDs or required visitors', () => {
  for (const [req, field] of [[input('0', visitorId), 'id'], [input('1'), 'visitorId'],
    [input('1', 'private-invalid-visitor'), 'visitorId']]) {
    const res = { locals: { existing: 'preserved' } }
    assert.throws(() => validateVideoViewRequest(req, res, () => assert.fail('Invalid input must not continue')), error => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 400)
      assert.deepEqual({ code: error.code, message: error.message, fields: error.fields }, errorBody(field))
      return true
    })
    assert.deepEqual(res.locals, { existing: 'preserved' })
  }
})

test('the public view POST validates input before SQL without changing the existing public GET contract', { timeout: 30000 }, async t => {
  const { request, getDb } = await startAuthServer(t, { uploads: true })
  const database = getDb()

  async function reject(subtest, cases) {
    const prepare = database.prepare.bind(database)
    const exec = database.exec.bind(database)
    const prepared = subtest.mock.method(database, 'prepare', (...args) => prepare(...args))
    const executed = subtest.mock.method(database, 'exec', (...args) => exec(...args))
    for (const { id, field, query = '', ...options } of cases) {
      const response = await request(`/api/videos/${encodeURIComponent(id)}/view` + query,
        { method: 'POST', ...options })
      assert.equal(response.status, 400)
      assert.deepEqual(response.json, errorBody(field))
      assert.equal(response.headers['set-cookie'], undefined)
    }
    assert.equal(prepared.mock.callCount(), 0)
    assert.equal(executed.mock.callCount(), 0)
  }

  await t.test('invalid IDs fail on the registered POST path before any query or transaction', async subtest => {
    await reject(subtest, ['0', '-1', '1.5', 'abc', '9007199254740992', '1/2', '１'].map(id => ({
      id, field: 'id', headers: { 'X-Visitor-Id': visitorId },
    })))
  })

  await t.test('missing, malformed and duplicate required visitors fail before lookup for ordinary and maximum valid IDs', async subtest => {
    const cases = []
    for (const id of ['1', '9007199254740991']) {
      cases.push({ id, field: 'visitorId' })
      for (const value of ['', 'private-invalid-visitor', '00000000-0000-0000-0000-000000000000',
        `${visitorId}, ${visitorId}`, [visitorId, visitorId], [visitorId, visitorId.toUpperCase()]]) {
        cases.push({ id, field: 'visitorId', headers: { 'X-Visitor-Id': value } })
      }
    }
    await reject(subtest, cases)
  })

  await t.test('body, query and cookies cannot replace a missing header or change the public validation response', async subtest => {
    await reject(subtest, [{ id: '1', field: 'visitorId', query: '?visitorId=' + visitorId,
      body: { visitorId }, cookie: 'visitorId=' + visitorId + '; admin_session=invalid',
      headers: { Origin: 'https://other.example.test' },
    }])
  })

  await t.test('anonymous list and detail GET requests remain available without the required write header', async () => {
    const id = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
      .run('Unchanged public video', 'videos/10000000-0000-4000-8000-000000000001.mp4').lastInsertRowid
    const list = await request('/api/videos')
    assert.equal(list.status, 200)
    assert.deepEqual(list.json.data.map(video => video.id), [id])
    const detail = await request('/api/videos/' + id)
    assert.equal(detail.status, 200)
    assert.equal(detail.json.id, id)
    assert.equal(detail.json.likedByMe, false)
  })
})
