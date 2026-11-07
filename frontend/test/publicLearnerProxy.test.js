import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer, loadConfigFromFile } from 'vite'
import { startAuthServer } from '../../backend/test/helpers/auth-server.js'
import { createDatabaseContext } from '../../backend/test/helpers/database-context.js'
import { insertMinimalFixture } from '../../backend/test/helpers/minimal-fixture.js'

const frontend = fileURLToPath(new URL('../', import.meta.url))
const visitor = '00000000-0000-4000-8000-000000000002'

test('existing learner request modules cross the real Vite proxy for public API flows', { timeout: 30000 }, async t => {
  const context = createDatabaseContext(t)
  const { getDb, port } = await startAuthServer(t, { uploads: true })
  const db = getDb()
  const fixture = insertMinimalFixture(db)
  const mediaPath = 'videos/10000000-0000-4000-8000-000000000001.mp4'
  db.prepare('UPDATE videos SET video_path = ? WHERE id = ?').run(mediaPath, fixture.videoId)
  const emptyVideo = db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('No quiz control', mediaPath).lastInsertRowid
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, join(frontend, 'vite.config.js'),
    frontend, 'silent', undefined, 'native')
  assert.ok(loaded)
  assert.equal(loaded.config.server.proxy['/api'], 'http://localhost:3000')
  const target = `http://127.0.0.1:${port}`
  const proxy = Object.fromEntries(Object.entries(loaded.config.server.proxy).map(([prefix, value]) =>
    [prefix, value === 'http://localhost:3000' ? target : value]))
  const vite = await createServer({
    ...loaded.config, root: frontend, configFile: false, mode: 'test', logLevel: 'silent',
    cacheDir: context.path('vite-cache'),
    define: { 'import.meta.env.VITE_FEED_PREVIEW': '"false"', 'import.meta.env.VITE_ADMIN_PREVIEW': '"false"',
      'import.meta.env.VITE_LEARNER_PREVIEW': '"false"' },
    server: { ...loaded.config.server, host: '127.0.0.1', port: 0, strictPort: true, open: false,
      watch: null, hmr: false, preTransformRequests: false, proxy },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  context.addCleanup(() => vite.close())
  await vite.listen()
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`
  const feed = await vite.ssrLoadModule('/src/api/feedApi.js')
  const learner = await vite.ssrLoadModule('/src/api/learnerApi.js')
  const videos = await vite.ssrLoadModule('/src/api/videoApi.js')
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const storage = new Map([['worklearn.visitorId', visitor]])
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  } })
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  })
  const nativeFetch = globalThis.fetch
  const calls = []
  t.mock.method(globalThis, 'fetch', (path, options = {}) => {
    calls.push({ path, method: options.method ?? 'GET', visitor: new Headers(options.headers).get('X-Visitor-Id') })
    return nativeFetch(new URL(path, base), options)
  })
  const path = `/api/videos/${fixture.videoId}`
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let createdComment

  await t.test('feed, tags, filtering and course modules use real responses and visitor-aware reactions remain idempotent', async () => {
    const list = await feed.getFeedVideos()
    assert.deepEqual(list.data.map(video => video.id), [emptyVideo, fixture.videoId])
    assert.deepEqual(calls.at(-1), { path: '/api/videos?page=1&limit=20', method: 'GET', visitor })
    assert.equal(list.data[1].likedByMe, false)
    assert.deepEqual(await videos.getTags(), { data: [{ id: fixture.tagId, name: 'Fixture tag' }] })
    const filtered = await learner.learnerRequest(`/api/videos?tagId=${fixture.tagId}`)
    assert.deepEqual(filtered.data.map(video => video.id), [fixture.videoId])
    const courses = await learner.getLearningCourses()
    assert.equal(courses.data[0].id, fixture.courseId)
    const course = await learner.getLearningCourse(fixture.courseId)
    const { sortOrder, ...fromCourse } = course.videos[0]
    assert.equal(sortOrder, 1)
    assert.deepEqual(fromCourse, list.data[1])
    assert.deepEqual(await feed.recordVideoView(fixture.videoId), { videoId: fixture.videoId, viewCount: 2, counted: true })
    assert.deepEqual(await feed.recordVideoView(fixture.videoId), { videoId: fixture.videoId, viewCount: 2, counted: false })
    for (const liked of [true, true, false]) {
      assert.deepEqual(await feed.setVideoLike(fixture.videoId, liked), {
        videoId: fixture.videoId, likeCount: liked ? 2 : 1, likedByMe: liked,
      })
    }
    const refreshed = await learner.getLearningCourse(fixture.courseId)
    assert.equal(refreshed.videos[0].viewCount, 2)
    assert.equal(refreshed.videos[0].likeCount, 1)
    assert.equal(refreshed.videos[0].likedByMe, false)
  })

  await t.test('the generic learner request transports comment creation, deletion and public quiz JSON through the proxy', async () => {
    // These generic calls verify transport readiness, not unfinished comment or quiz screens.
    const created = await learner.learnerRequest(`${path}/comments`, json('POST', {
      nickname: 'Proxy learner', password: '1234', content: 'Proxy comment',
    }))
    createdComment = created.id
    assert.deepEqual(Object.keys(created), ['id', 'videoId', 'nickname', 'content', 'createdAt'])
    assert.equal(created.videoId, fixture.videoId)
    assert.equal((await learner.learnerRequest(`${path}/comments`)).total, 2)
    assert.equal((await learner.getLearningCourse(fixture.courseId)).videos[0].commentCount, 2)
    const quiz = await learner.learnerRequest(`${path}/quiz`)
    assert.deepEqual(quiz, { id: fixture.quizId, videoId: fixture.videoId, question: 'Fixture question?', options: [
      { id: fixture.correctOptionId, content: 'Correct option', sortOrder: 1, isCorrect: true },
      { id: fixture.incorrectOptionId, content: 'Incorrect option', sortOrder: 2, isCorrect: false },
    ] })
    await assert.rejects(learner.learnerRequest(`/api/comments/${createdComment}`, json('DELETE', { password: 'wrong-password' })),
      error => error.status === 403 && error.code === 'COMMENT_PASSWORD_MISMATCH')
    assert.equal(await learner.learnerRequest(`/api/comments/${createdComment}`, json('DELETE', { password: '1234' })), null)
    assert.equal((await learner.learnerRequest(`${path}/comments`)).total, 1)
    const course = await learner.getLearningCourse(fixture.courseId)
    assert.equal(course.videos[0].commentCount, 1)
    assert.equal(course.videos[0].hasQuiz, true)
    assert.equal(db.prepare('SELECT id FROM comments WHERE id = ?').get(createdComment), undefined)
  })

  await t.test('comment and quiz errors preserve backend codes and field errors instead of becoming SPA success HTML', async () => {
    await assert.rejects(learner.learnerRequest('/api/videos/0/quiz'),
      error => error.status === 400 && error.code === 'VALIDATION_ERROR' && typeof error.fields.id === 'string')
    await assert.rejects(learner.learnerRequest(`/api/videos/${emptyVideo}/quiz`),
      error => error.status === 404 && error.code === 'NOT_FOUND')
    await assert.rejects(learner.learnerRequest(`${path}/comments`, json('POST', {})),
      error => error.status === 400 && error.code === 'VALIDATION_ERROR' &&
        ['nickname', 'password', 'content'].every(field => typeof error.fields[field] === 'string'))
    await assert.rejects(learner.learnerRequest(`${path}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}',
    }), error => error.status === 415 && error.code === 'UNSUPPORTED_MEDIA_TYPE')
    await assert.rejects(learner.learnerRequest(`${path}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad',
    }), error => error.status === 400 && error.code === 'INVALID_JSON')
    assert.equal(db.isTransaction, false)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  })
})
