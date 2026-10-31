import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { validateVideoLikeRequest } from '../../src/middleware/validateVideoLikeRequest.js'
import { withVideoWriteTransaction } from '../../src/services/video-write.js'
import { startAuthServer } from '../helpers/auth-server.js'

const visitorId = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const messages = {
  id: 'ID는 1 이상 9007199254740991 이하의 정수로 입력하세요.',
  visitorId: '방문자 ID는 올바른 UUID 형식으로 입력하세요.',
}
const errorBody = field => ({ code: 'VALIDATION_ERROR', message: '입력값을 확인하세요.', fields: { [field]: messages[field] } })

function input(id, visitor) {
  return Object.freeze({ params: Object.freeze({ id }),
    headers: Object.freeze(visitor === undefined ? {} : { 'x-visitor-id': visitor }),
    rawHeaders: Object.freeze(visitor === undefined ? [] : ['X-Visitor-Id', visitor]),
  })
}

test('like validation publishes normalized IDs and required visitors together without mutating the request', () => {
  for (const [id, expected] of [['0001', 1], ['9007199254740991', Number.MAX_SAFE_INTEGER]]) {
    const req = input(id, visitorId.toUpperCase())
    const res = { locals: { existing: 'preserved' } }
    let continued = 0
    validateVideoLikeRequest(req, res, () => { continued += 1 })
    assert.equal(continued, 1)
    assert.deepEqual(res.locals, { existing: 'preserved', videoLikeRequest: { id: expected, visitorId } })
    assert.equal(req.params.id, id)
    assert.equal(req.headers['x-visitor-id'], visitorId.toUpperCase())
  }
})

test('like validation rejects invalid input before continuation and publishes no partial context', () => {
  for (const [req, field] of [[input('0', visitorId), 'id'], [input('1'), 'visitorId'],
    [input('1', 'private-invalid-visitor'), 'visitorId'], [input('0'), 'id']]) {
    const res = { locals: { existing: 'preserved' } }
    assert.throws(() => validateVideoLikeRequest(req, res, () => assert.fail('Invalid requests must stop')), error => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 400)
      assert.deepEqual({ code: error.code, message: error.message, fields: error.fields }, errorBody(field))
      return true
    })
    assert.deepEqual(res.locals, { existing: 'preserved' })
  }
})

test('both production like methods validate before SQL and retain the existing write-boundary contract', { timeout: 30000 }, async t => {
  const { request, getDb } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const id = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Like validation target', 'videos/10000000-0000-4000-8000-000000000001.mp4').lastInsertRowid

  async function rejectWithoutSql(subtest, cases) {
    const prepare = database.prepare.bind(database)
    const exec = database.exec.bind(database)
    const prepared = subtest.mock.method(database, 'prepare', (...args) => prepare(...args))
    const executed = subtest.mock.method(database, 'exec', (...args) => exec(...args))
    try {
      for (const method of ['PUT', 'DELETE']) {
        for (const { id: target, field, query = '', ...options } of cases) {
          const response = await request(`/api/videos/${encodeURIComponent(target)}/like` + query, { method, ...options })
          assert.equal(response.status, 400)
          assert.deepEqual(response.json, errorBody(field))
          assert.equal(response.headers['set-cookie'], undefined)
        }
      }
      assert.equal(prepared.mock.callCount(), 0)
      assert.equal(executed.mock.callCount(), 0)
    } finally {
      prepared.mock.restore()
      executed.mock.restore()
    }
  }

  await t.test('invalid path IDs return the same field error for PUT and DELETE without lookup', async subtest => {
    await rejectWithoutSql(subtest, ['0', '-1', '1.5', 'abc', '9007199254740992', '1/2', '１'].map(target => ({
      id: target, field: 'id', headers: { 'X-Visitor-Id': visitorId },
    })))
  })

  await t.test('absent, malformed and duplicate headers fail for existing and valid missing IDs before opening a transaction', async subtest => {
    const cases = []
    for (const target of [id, Number.MAX_SAFE_INTEGER]) {
      cases.push({ id: target, field: 'visitorId' })
      for (const visitor of ['', 'private-invalid-visitor', '00000000-0000-0000-0000-000000000000',
        `${visitorId}, ${visitorId}`, [visitorId, visitorId], [visitorId, visitorId.toUpperCase()]]) {
        cases.push({ id: target, field: 'visitorId', headers: { 'X-Visitor-Id': visitor } })
      }
    }
    await rejectWithoutSql(subtest, cases)
  })

  await t.test('body, query and cookies cannot replace the required header or change public validation', async subtest => {
    await rejectWithoutSql(subtest, [{ id, field: 'visitorId', query: '?visitorId=' + visitorId,
      body: { visitorId }, cookie: 'visitorId=' + visitorId + '; admin_session=invalid',
      headers: { Origin: 'https://other.example.test' },
    }])
  })

  await t.test('validated context reuses the existing write boundary for normalized targets and the same missing-video error', () => {
    for (const target of ['000' + id, String(Number.MAX_SAFE_INTEGER)]) {
      const res = { locals: {} }
      validateVideoLikeRequest(input(target, visitorId.toUpperCase()), res, () => {})
      const validated = res.locals.videoLikeRequest
      if (validated.id === id) {
        const result = withVideoWriteTransaction(database, validated.id, connection => {
          assert.equal(connection, database)
          assert.equal(connection.isTransaction, true)
          assert.equal(validated.visitorId, visitorId)
          return 'existing target'
        })
        assert.equal(result, 'existing target')
      } else {
        assert.throws(() => withVideoWriteTransaction(database, validated.id,
          () => assert.fail('Missing videos must not reach the like operation')), error => {
          assert.ok(error instanceof ApiError)
          assert.equal(error.status, 404)
          assert.equal(error.code, 'NOT_FOUND')
          assert.equal(error.message, '영상을 찾을 수 없습니다.')
          assert.deepEqual(error.fields, {})
          return true
        })
      }
      assert.equal(database.isTransaction, false)
      assert.equal(database.isOpen, true)
    }
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_likes').get().count, 0)
  })

  await t.test('anonymous GETs and the existing view POST remain available without adding a like', async () => {
    const list = await request('/api/videos')
    assert.equal(list.status, 200)
    assert.deepEqual(list.json.data.map(video => [video.id, video.likeCount, video.likedByMe]), [[id, 0, false]])
    const detail = await request('/api/videos/' + id)
    assert.equal(detail.status, 200)
    assert.equal(detail.json.likedByMe, false)
    const view = await request(`/api/videos/${id}/view`, { method: 'POST', headers: { 'X-Visitor-Id': visitorId } })
    assert.equal(view.status, 200)
    assert.deepEqual(view.json, { videoId: id, viewCount: 1, counted: true })
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_likes').get().count, 0)
  })
})
