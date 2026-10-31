import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { validateVideoListRequest } from '../../src/middleware/validateVideoListRequest.js'
import { startAuthServer } from '../helpers/auth-server.js'

const visitorId = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const fields = {
  page: '페이지는 1 이상 9007199254740991 이하의 정수로 입력하세요.',
  limit: '페이지당 항목 수는 1 이상 50 이하의 정수로 입력하세요.',
  tagId: 'tagId는 1 이상 9007199254740991 이하의 정수로 입력하세요.',
  visitorId: '방문자 ID는 올바른 UUID 형식으로 입력하세요.',
}

function input(query, visitor) {
  return Object.freeze({
    query: Object.freeze(query),
    headers: Object.freeze(visitor === undefined ? {} : { 'x-visitor-id': visitor }),
    rawHeaders: Object.freeze(visitor === undefined ? [] : ['X-Visitor-Id', visitor]),
  })
}

test('video list validation passes complete defaults and normalized values to the next handler without mutating inputs', () => {
  for (const [req, expected] of [
    [input({}), { page: 1, limit: 20, tagId: null, visitorId: null }],
    [input({ page: '0002' }), { page: 2, limit: 20, tagId: null, visitorId: null }],
    [input({ limit: '050' }, visitorId.toUpperCase()), { page: 1, limit: 50, tagId: null, visitorId }],
    [input({ page: '9007199254740991', limit: '1' }), { page: Number.MAX_SAFE_INTEGER, limit: 1, tagId: null, visitorId: null }],
    [input({ tagId: '1' }), { page: 1, limit: 20, tagId: 1, visitorId: null }],
    [input({ page: '0002', limit: '050', tagId: '0007' }, visitorId.toUpperCase()), { page: 2, limit: 50, tagId: 7, visitorId }],
    [input({ tagId: '9007199254740991' }), { page: 1, limit: 20, tagId: Number.MAX_SAFE_INTEGER, visitorId: null }],
    [input({ tagId: '0009007199254740991' }), { page: 1, limit: 20, tagId: Number.MAX_SAFE_INTEGER, visitorId: null }],
  ]) {
    const res = { locals: { existing: 'preserved' } }
    let calls = 0
    validateVideoListRequest(req, res, () => { calls += 1 })
    assert.equal(calls, 1)
    assert.deepEqual(res.locals, { existing: 'preserved', videoListRequest: expected })
  }
})

test('video list validation does not publish partial inputs or continue when a later field fails', () => {
  for (const [req, field] of [
    [input({ page: '2', limit: '51' }), 'limit'],
    [input({ page: '2', limit: '20', tagId: '0' }), 'tagId'],
    [input({ page: '2', limit: '20', tagId: '7' }, 'invalid-private-visitor'), 'visitorId'],
  ]) {
    const res = { locals: { existing: 'preserved' } }
    assert.throws(() => validateVideoListRequest(req, res, () => assert.fail('Rejected input must not continue')), error => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 400)
      assert.deepEqual(error.fields, { [field]: fields[field] })
      return true
    })
    assert.deepEqual(res.locals, { existing: 'preserved' })
  }
})

test('invalid optional tag IDs never continue or publish partially validated list input', () => {
  for (const value of ['', '0', '-1', '+1', '1.5', '1e2', '0x10', ' 1', '1 ', '１', '1;DROP',
    '9007199254740992', '9'.repeat(400), null, 1, true, ['1'], ['1', '1'], ['1', '2'], {}]) {
    const res = { locals: { existing: 'preserved' } }
    assert.throws(() => validateVideoListRequest(input({ page: '2', limit: '20', tagId: value }), res,
      () => assert.fail('Invalid tags must stop before the list handler')), error => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 400)
      assert.equal(error.code, 'VALIDATION_ERROR')
      assert.deepEqual(error.fields, { tagId: fields.tagId })
      return true
    })
    assert.deepEqual(res.locals, { existing: 'preserved' })
  }
})

test('the public video list path validates real parsed query and header input before database access', { timeout: 30000 }, async t => {
  const { request, getDb } = await startAuthServer(t, { uploads: true })
  const database = getDb()

  async function reject(path, field, headers = {}) {
    const response = await request(path, { headers })
    assert.equal(response.status, 400, path)
    assert.deepEqual(response.json, {
      code: 'VALIDATION_ERROR', message: '입력값을 확인하세요.', fields: { [field]: fields[field] },
    })
    assert.equal(response.headers['set-cookie'], undefined)
  }

  await t.test('invalid, blank and repeated page parameters produce the fixed page error with no SQL', async subtest => {
    const prepare = database.prepare.bind(database)
    const observed = subtest.mock.method(database, 'prepare', (...args) => prepare(...args))
    for (const query of ['page', 'page=', 'page=0', 'page=-1', 'page=1.5', 'page=abc',
      'page=9007199254740992', 'page=1&page=1', 'page=1&page=2', 'page=%20', 'page=private-path']) {
      await reject('/api/videos?' + query, 'page')
    }
    assert.equal(observed.mock.callCount(), 0)
  })

  await t.test('invalid, blank and repeated limit parameters produce the fixed limit error with no SQL', async subtest => {
    const prepare = database.prepare.bind(database)
    const observed = subtest.mock.method(database, 'prepare', (...args) => prepare(...args))
    for (const query of ['limit', 'limit=', 'limit=0', 'limit=-1', 'limit=1.5', 'limit=abc',
      'limit=51', 'limit=9007199254740991', 'limit=20&limit=20', 'limit=20&limit=50', 'limit=%20']) {
      await reject('/api/videos?' + query, 'limit')
    }
    assert.equal(observed.mock.callCount(), 0)
  })

  await t.test('invalid and duplicate visitor headers are rejected on list requests without querying the database', async subtest => {
    const prepare = database.prepare.bind(database)
    const observed = subtest.mock.method(database, 'prepare', (...args) => prepare(...args))
    for (const value of ['', 'invalid-private-visitor', '00000000-0000-0000-0000-000000000000',
      visitorId + ', ' + visitorId, [visitorId, visitorId], [visitorId, visitorId.toUpperCase()]]) {
      await reject('/api/videos?page=2&limit=50', 'visitorId', { 'X-Visitor-Id': value })
    }
    assert.equal(observed.mock.callCount(), 0)
  })

  await t.test('blank, invalid and duplicate tag parameters return the shared tag error before SQL or transactions', async subtest => {
    const prepare = database.prepare.bind(database)
    const exec = database.exec.bind(database)
    const prepared = subtest.mock.method(database, 'prepare', (...args) => prepare(...args))
    const executed = subtest.mock.method(database, 'exec', (...args) => exec(...args))
    try {
      for (const query of ['tagId', 'tagId=', 'tagId=0', 'tagId=-1', 'tagId=%2B1', 'tagId=1.5', 'tagId=abc',
        'tagId=1e2', 'tagId=0x10', 'tagId=9007199254740992', 'tagId=1&tagId=1', 'tagId=1&tagId=2',
        'tagId=%20', 'tagId=%201', 'tagId=1%20', 'tagId=%EF%BC%91', 'tagId=1%3BDROP', 'tagId=' + '9'.repeat(400)]) {
        await reject('/api/videos?page=2&limit=20&' + query, 'tagId')
      }
      assert.equal(prepared.mock.callCount(), 0)
      assert.equal(executed.mock.callCount(), 0)
    } finally {
      prepared.mock.restore()
      executed.mock.restore()
    }
  })

  await t.test('omitted and valid optional tag IDs pass the actual query parser without changing the list envelope', async () => {
    // Valid tags may have no matching videos, so the normal empty page envelope still applies.
    for (const query of ['', '?tagId=1', '?tagId=0007', '?tagId=9007199254740991']) {
      const response = await request('/api/videos' + query, { headers: { 'X-Visitor-Id': visitorId.toUpperCase() } })
      assert.equal(response.status, 200)
      assert.deepEqual(response.json, { data: [], page: 1, limit: 20, total: 0 })
      assert.equal(response.headers['set-cookie'], undefined)
    }
  })

  await t.test('list validation does not apply list query rules to the separate detail endpoint', async () => {
    const id = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
      .run('Independent detail video', 'videos/10000000-0000-4000-8000-000000000001.mp4').lastInsertRowid
    const response = await request(`/api/videos/${id}?page=0&limit=51&tagId=invalid`)
    assert.equal(response.status, 200)
    assert.equal(response.json.id, id)
  })
})
