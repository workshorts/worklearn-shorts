import assert from 'node:assert/strict'
import test from 'node:test'
import { loadVideoDetail } from '../../src/services/video-read.js'
import { startAuthServer } from '../helpers/auth-server.js'

const visitorId = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const keys = ['id', 'title', 'description', 'tags', 'videoUrl', 'thumbnailUrl', 'viewCount', 'likeCount',
  'likedByMe', 'commentCount', 'hasQuiz', 'createdAt', 'updatedAt']

test('the merged application exposes public video details through the existing shared service', { timeout: 30000 }, async t => {
  const { request, login, getDb } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const insert = database.prepare('INSERT INTO videos (title, description, video_path) VALUES (?, ?, ?)')
  const id = insert.run('Public detail video', 'Selected video description',
    'videos/10000000-0000-4000-8000-000000000001.mp4').lastInsertRowid
  insert.run('Other video', '', 'videos/10000000-0000-4000-8000-000000000002.webm')
  database.prepare('INSERT INTO video_likes (video_id, visitor_id) VALUES (?, ?)').run(id, visitorId)

  await t.test('anonymous GET returns the complete shared Video as JSON without a cookie or content-type requirement', async () => {
    const response = await request(`/api/videos/${id}`)
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.deepEqual(Object.keys(response.json).sort(), [...keys].sort())
    assert.deepEqual(response.json, loadVideoDetail(database, { id }))
    assert.equal(response.json.id, id)
    assert.equal(response.json.likedByMe, false)
  })

  await t.test('detail GET accepts leading zeros and normalizes a valid uppercase visitor header before service lookup', async () => {
    const response = await request(`/api/videos/000${id}`, { headers: { 'X-Visitor-Id': visitorId.toUpperCase() } })
    assert.equal(response.status, 200)
    assert.deepEqual(response.json, loadVideoDetail(database, { id, visitorId }))
    assert.equal(response.json.likedByMe, true)
  })

  await t.test('public details do not require a valid administrator cookie or an allowed administrator origin', async () => {
    const response = await request(`/api/videos/${id}`, {
      cookie: 'admin_session=not-a-valid-session', headers: { Origin: 'https://other.example.test' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.json.id, id)
    assert.equal(response.headers['set-cookie'], undefined)
  })

  await t.test('invalid path IDs return fixed validation errors without executing a database query', async subtest => {
    const prepare = database.prepare.bind(database)
    const observed = subtest.mock.method(database, 'prepare', (...args) => prepare(...args))
    for (const value of ['0', '-1', '1.5', 'abc', '1e2', '9007199254740992', '9007199254740993',
      ' ', '１', '1/2', 'private-id C:/private/app.db']) {
      const response = await request('/api/videos/' + encodeURIComponent(value))
      assert.equal(response.status, 400, value)
      assert.deepEqual(response.json, {
        code: 'VALIDATION_ERROR', message: '입력값을 확인하세요.',
        fields: { id: 'ID는 1 이상 9007199254740991 이하의 정수로 입력하세요.' },
      })
    }
    assert.equal(observed.mock.callCount(), 0)
  })

  await t.test('invalid, blank and duplicate optional visitor headers fail before lookup even for missing videos', async subtest => {
    const prepare = database.prepare.bind(database)
    const observed = subtest.mock.method(database, 'prepare', (...args) => prepare(...args))
    for (const value of ['', 'invalid-private-visitor', '00000000-0000-0000-0000-000000000000',
      visitorId + ', ' + visitorId, [visitorId, visitorId], [visitorId, visitorId.toUpperCase()]]) {
      for (const selectedId of [id, 999999]) {
        const response = await request(`/api/videos/${selectedId}`, { headers: { 'X-Visitor-Id': value } })
        assert.equal(response.status, 400)
        assert.deepEqual(response.json, {
          code: 'VALIDATION_ERROR', message: '입력값을 확인하세요.',
          fields: { visitorId: '방문자 ID는 올바른 UUID 형식으로 입력하세요.' },
        })
      }
    }
    assert.equal(observed.mock.callCount(), 0)
  })

  await t.test('valid missing IDs return the shared not-found contract rather than validation errors', async () => {
    for (const missing of [999999, Number.MAX_SAFE_INTEGER]) {
      const response = await request(`/api/videos/${missing}`)
      assert.equal(response.status, 404)
      assert.deepEqual(response.json, { code: 'NOT_FOUND', message: '영상을 찾을 수 없습니다.', fields: {} })
    }
  })

  await t.test('database failures use the existing safe internal-error boundary and normal detail requests recover', async subtest => {
    const log = subtest.mock.method(console, 'error', () => {})
    const fault = subtest.mock.method(database, 'prepare', () => {
      throw new Error('SELECT private_hash at C:/private/app.db with private-session')
    })
    try {
      const response = await request(`/api/videos/${id}`)
      assert.equal(response.status, 500)
      assert.deepEqual(response.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
      assert.equal(response.headers['set-cookie'], undefined)
    } finally {
      fault.mock.restore()
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
    assert.equal((await request(`/api/videos/${id}`)).status, 200)
  })

  await t.test('existing administrator, uploads and courses routes remain available after public video registration', async () => {
    assert.equal((await request('/api/admin/me')).status, 401)
    assert.equal((await request('/api/admin/uploads', { method: 'POST' })).status, 401)
    assert.equal((await login()).res.status, 200)
    const courses = await request('/api/courses')
    assert.equal(courses.status, 200)
    assert.deepEqual(courses.json, { data: [], page: 1, limit: 20, total: 0 })
  })
})
