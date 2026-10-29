import assert from 'node:assert/strict'
import test from 'node:test'
import { loadVideoList } from '../../src/services/video-read.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const visitorId = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const videoPath = 'videos/10000000-0000-4000-8000-000000000001.mp4'
const keys = ['id', 'title', 'description', 'tags', 'videoUrl', 'thumbnailUrl', 'viewCount', 'likeCount',
  'likedByMe', 'commentCount', 'hasQuiz', 'createdAt', 'updatedAt']
const internalError = { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} }

test('the production video list GET returns the validated page through the shared list service', { timeout: 30000 }, async t => {
  const { request, getDb } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const { videoId } = insertMinimalFixture(database)
  database.prepare('UPDATE videos SET video_path = ? WHERE id = ?').run(videoPath, videoId)
  database.prepare('UPDATE video_likes SET visitor_id = ? WHERE video_id = ?').run(visitorId, videoId)
  const insert = database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
  insert.run(5, 'Middle list video', videoPath)
  insert.run(9, 'Newest list video', videoPath)

  function expected(page = 1, limit = 20, visitor = null) {
    const { data, total } = loadVideoList(database, { page, limit, visitorId: visitor })
    return { data, page, limit, total }
  }

  await t.test('anonymous GET returns only the page envelope and complete public Videos using the default page and limit', async () => {
    const response = await request('/api/videos')
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.deepEqual(Object.keys(response.json).sort(), ['data', 'limit', 'page', 'total'])
    assert.deepEqual(response.json, expected())
    assert.deepEqual(response.json.data.map(video => video.id), [9, 5, videoId])
    for (const video of response.json.data) {
      assert.deepEqual(Object.keys(video).sort(), [...keys].sort())
      assert.equal(video.likedByMe, false)
    }
  })

  await t.test('explicit pagination and uppercase visitor headers reach the service as normalized values', async () => {
    const response = await request('/api/videos?page=0002&limit=0002', {
      headers: { 'X-Visitor-Id': visitorId.toUpperCase() },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(response.json, expected(2, 2, visitorId))
    assert.deepEqual(response.json.data.map(video => video.id), [videoId])
    assert.equal(response.json.total, 3)
    assert.equal(response.json.data[0].likedByMe, true)
  })

  await t.test('an omitted page or limit independently retains its default in the actual page response', async () => {
    for (const [query, page, limit] of [['?limit=2', 1, 2], ['?page=2', 2, 20]]) {
      const response = await request('/api/videos' + query)
      assert.equal(response.status, 200)
      assert.deepEqual(response.json, expected(page, limit))
    }
  })

  await t.test('public list access ignores administrator authentication and does not use query or cookie visitor identity', async () => {
    const response = await request('/api/videos?visitorId=' + visitorId, {
      cookie: 'admin_session=not-a-valid-session; visitorId=' + visitorId,
      headers: { Origin: 'https://other.example.test' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.deepEqual(response.json, expected())
    assert.equal(response.json.data.find(video => video.id === videoId).likedByMe, false)
  })

  await t.test('database errors return the shared safe 500 and a subsequent list request recovers', async subtest => {
    const log = subtest.mock.method(console, 'error', () => {})
    const fault = subtest.mock.method(database, 'prepare', () => {
      throw new Error('SELECT private_hash at C:/private/app.db with private-session')
    })
    try {
      const response = await request('/api/videos')
      assert.equal(response.status, 500)
      assert.deepEqual(response.json, internalError)
      assert.equal(response.headers['set-cookie'], undefined)
      assert.equal(database.isTransaction, false)
      assert.equal(database.isOpen, true)
    } finally {
      fault.mock.restore()
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
    const recovered = await request('/api/videos')
    assert.equal(recovered.status, 200)
    assert.deepEqual(recovered.json, expected())
  })

  await t.test('mapping failures return one safe 500 rather than a partially serialized successful page', async subtest => {
    const log = subtest.mock.method(console, 'error', () => {})
    database.prepare('UPDATE videos SET video_path = ? WHERE id = ?').run('invalid-private-path', videoId)
    try {
      const response = await request('/api/videos')
      assert.equal(response.status, 500)
      assert.deepEqual(response.json, internalError)
      assert.equal(response.headers['set-cookie'], undefined)
      assert.equal(database.isTransaction, false)
      assert.equal(database.isOpen, true)
    } finally {
      database.prepare('UPDATE videos SET video_path = ? WHERE id = ?').run(videoPath, videoId)
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
    const recovered = await request('/api/videos')
    assert.equal(recovered.status, 200)
    assert.deepEqual(recovered.json, expected())
  })
})
