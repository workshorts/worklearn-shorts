import assert from 'node:assert/strict'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'

const visitorA = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const visitorB = '12345678-abcd-4abc-9def-012345abcdef'
const visitorC = 'fedcba98-7654-4abc-bdef-012345abcdef'
const internalError = { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} }

test('the public view POST returns the committed videoId, viewCount and counted through the production app', { timeout: 30000 }, async t => {
  const { request, getDb } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const insert = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
  const firstId = insert.run('First HTTP view target', 'videos/10000000-0000-4000-8000-000000000001.mp4').lastInsertRowid
  const secondId = insert.run('Second HTTP view target', 'videos/10000000-0000-4000-8000-000000000002.webm').lastInsertRowid

  function post(id, visitor = visitorA, options = {}) {
    return request(`/api/videos/${id}/view`, { method: 'POST', ...options,
      headers: { 'X-Visitor-Id': visitor, ...options.headers },
    })
  }

  function count(id) {
    return database.prepare('SELECT COUNT(*) AS count FROM video_views WHERE video_id = ?').get(id).count
  }

  function assertSuccess(response, videoId, viewCount, counted) {
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.deepEqual(response.json, { videoId, viewCount, counted })
    assert.equal(database.isTransaction, false)
    assert.equal(database.isOpen, true)
  }

  function assertInternal(response) {
    assert.equal(response.status, 500)
    assert.deepEqual(response.json, internalError)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.equal(database.isTransaction, false)
    assert.equal(database.isOpen, true)
  }

  await t.test('a valid visitor without a body, content-type or administrator cookie receives the committed three-field 200', async () => {
    assertSuccess(await post(firstId), firstId, 1, true)
    assert.equal(count(firstId), 1)
    assert.equal(database.prepare('SELECT visitor_id FROM video_views WHERE video_id = ?').get(firstId).visitor_id, visitorA)
  })

  await t.test('leading-zero IDs and uppercase visitor headers reuse the same row with public cookie and origin handling', async () => {
    const response = await post('000' + firstId, visitorA.toUpperCase(), {
      cookie: 'admin_session=invalid', headers: { Origin: 'https://other.example.test' },
    })
    assertSuccess(response, firstId, 1, false)
    assert.equal(count(firstId), 1)
  })

  await t.test('valid missing targets return the shared 404 and never create an orphan view', async () => {
    for (const id of [999999, Number.MAX_SAFE_INTEGER]) {
      const response = await post(id)
      assert.equal(response.status, 404)
      assert.deepEqual(response.json, { code: 'NOT_FOUND', message: '영상을 찾을 수 없습니다.', fields: {} })
      assert.equal(count(id), 0)
      assert.equal(database.isTransaction, false)
    }
  })

  await t.test('a database lookup failure becomes one safe 500 and the next request can record a new pair', async subtest => {
    const log = subtest.mock.method(console, 'error', () => {})
    const fault = subtest.mock.method(database, 'prepare', () => {
      throw new Error('SELECT private_hash at C:/private/app.db with private-session')
    })
    try {
      assertInternal(await post(secondId))
    } finally {
      fault.mock.restore()
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
    assert.equal(count(secondId), 0)
    assertSuccess(await post(secondId), secondId, 1, true)
  })

  await t.test('an aggregation failure returns no partial success and rolls back the inserted visitor before retry', async subtest => {
    const log = subtest.mock.method(console, 'error', () => {})
    const prepare = database.prepare.bind(database)
    const fault = subtest.mock.method(database, 'prepare', sql => {
      if (sql.startsWith('SELECT COUNT(*)')) throw new Error('Injected HTTP aggregation failure')
      return prepare(sql)
    })
    try {
      assertInternal(await post(secondId, visitorB))
    } finally {
      fault.mock.restore()
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
    assert.equal(count(secondId), 1)
    assertSuccess(await post(secondId, visitorB), secondId, 2, true)
  })

  await t.test('a commit failure returns one safe 500 and rolls back before a successful new retry', async subtest => {
    const log = subtest.mock.method(console, 'error', () => {})
    const exec = database.exec.bind(database)
    const fault = subtest.mock.method(database, 'exec', sql => {
      if (sql === 'COMMIT') throw new Error('Injected HTTP commit failure')
      return exec(sql)
    })
    try {
      assertInternal(await post(secondId, visitorC))
    } finally {
      fault.mock.restore()
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
    assert.equal(count(secondId), 2)
    assertSuccess(await post(secondId, visitorC), secondId, 3, true)
  })

  await t.test('existing anonymous list and detail GETs observe the committed counts without recording extra views', async () => {
    const list = await request('/api/videos')
    assert.equal(list.status, 200)
    assert.deepEqual(list.json.data.map(video => [video.id, video.viewCount]), [[secondId, 3], [firstId, 1]])
    for (const [id, expectedCount] of [[firstId, 1], [secondId, 3]]) {
      const detail = await request('/api/videos/' + id)
      assert.equal(detail.status, 200)
      assert.equal(detail.json.viewCount, expectedCount)
      assert.equal(detail.json.likeCount, 0)
      assert.equal(detail.json.likedByMe, false)
      assert.equal(count(id), expectedCount)
    }
  })
})
