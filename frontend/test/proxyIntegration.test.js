import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer, loadConfigFromFile } from 'vite'
import { startAuthServer } from '../../backend/test/helpers/auth-server.js'
import { createDatabaseContext } from '../../backend/test/helpers/database-context.js'
import { insertMinimalFixture } from '../../backend/test/helpers/minimal-fixture.js'

const frontend = fileURLToPath(new URL('../', import.meta.url))
const visitor = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('frontend request modules use the real Vite API and upload proxies and receive the shared thumbnail asset', { timeout: 30000 }, async t => {
  const viteContext = createDatabaseContext(t)
  const { getDb, databasePath, uploadDir, port: backendPort } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const fixture = insertMinimalFixture(database)
  const mp4Path = 'videos/10000000-0000-4000-8000-000000000001.mp4'
  const webmPath = 'videos/20000000-0000-4000-8000-000000000002.webm'
  const pngPath = 'thumbnails/10000000-0000-4000-8000-000000000001.png'
  // Transport fixtures exercise file serving and ranges; they are not playable service videos.
  const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex')
  const webm = Buffer.from('1a45dfa3874282847765626d', 'hex')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  for (const directory of ['videos', 'thumbnails']) mkdirSync(join(uploadDir, directory))
  for (const [path, bytes] of [[mp4Path, mp4], [webmPath, webm], [pngPath, png]]) writeFileSync(join(uploadDir, path), bytes)
  database.prepare('UPDATE videos SET video_path = ?, thumbnail_path = ? WHERE id = ?').run(mp4Path, pngPath, fixture.videoId)
  database.prepare('UPDATE video_likes SET visitor_id = ? WHERE video_id = ?').run(visitor, fixture.videoId)
  const secondId = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Default thumbnail proxy video', webmPath).lastInsertRowid

  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, join(frontend, 'vite.config.js'), frontend, 'silent', undefined, 'native')
  assert.ok(loaded)
  for (const prefix of ['/api', '/uploads']) assert.equal(loaded.config.server.proxy[prefix], 'http://localhost:3000')
  const target = 'http://127.0.0.1:' + backendPort
  // Keep the repository's proxy prefixes and plugins, changing only the target port for isolation.
  const proxy = Object.fromEntries(Object.entries(loaded.config.server.proxy).map(([prefix, value]) =>
    [prefix, value === 'http://localhost:3000' ? target : value]))
  const vite = await createServer({
    ...loaded.config, root: frontend, configFile: false, mode: 'test', logLevel: 'silent',
    cacheDir: viteContext.path('vite-cache'),
    define: { 'import.meta.env.VITE_FEED_PREVIEW': '"false"', 'import.meta.env.VITE_ADMIN_PREVIEW': '"false"',
      'import.meta.env.VITE_LEARNER_PREVIEW': '"false"' },
    server: { ...loaded.config.server, host: '127.0.0.1', port: 0, strictPort: true, open: false,
      watch: null, hmr: false, preTransformRequests: false, proxy },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  viteContext.addCleanup(() => vite.close())
  await vite.listen()
  const base = 'http://127.0.0.1:' + vite.httpServer.address().port
  const feedApi = await vite.ssrLoadModule('/src/api/feedApi.js')
  const learnerApi = await vite.ssrLoadModule('/src/api/learnerApi.js')
  const videoApi = await vite.ssrLoadModule('/src/api/videoApi.js')
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const storage = new Map([['worklearn.visitorId', visitor]])
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  } })
  t.after(() => {
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
    else delete globalThis.localStorage
  })
  const nativeFetch = globalThis.fetch
  const calls = []
  t.mock.method(globalThis, 'fetch', (path, options = {}) => {
    calls.push({ path, visitor: new Headers(options.headers).get('X-Visitor-Id') })
    return nativeFetch(new URL(path, base), options)
  })

  function snapshot() {
    return {
      rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
      schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
      hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
    }
  }

  async function fetchAsset(path, options = {}) {
    return nativeFetch(new URL(path, base), { ...options, signal: AbortSignal.timeout(5000) })
  }

  const before = snapshot()
  let videos
  await t.test('real frontend feed, detail and tag functions cross the Vite proxy with the visitor header intact', async () => {
    const feed = await feedApi.getFeedVideos()
    assert.deepEqual([feed.page, feed.limit, feed.total], [1, 20, 2])
    assert.deepEqual(feed.data.map(video => video.id), [secondId, fixture.videoId])
    videos = feed.data
    assert.deepEqual(calls.at(-1), { path: '/api/videos?page=1&limit=20', visitor })
    assert.equal(videos[1].likedByMe, true)
    assert.equal(videos[1].videoUrl, '/uploads/' + mp4Path)
    assert.equal(videos[0].thumbnailUrl, '/images/default-thumbnail.svg')
    const detail = await learnerApi.learnerRequest('/api/videos/' + fixture.videoId, { visitor: true })
    assert.deepEqual(detail, videos[1])
    assert.deepEqual(await videoApi.getTags(), { data: [{ id: fixture.tagId, name: 'Fixture tag' }] })
    assert.equal(calls.at(-1).path, '/api/tags')
  })

  await t.test('MP4 and WebM URLs retain exact full content, HEAD metadata and partial-range responses through uploads', async () => {
    for (const [path, bytes, type] of [[videos[1].videoUrl, mp4, 'video/mp4'], [videos[0].videoUrl, webm, 'video/webm']]) {
      const full = await fetchAsset(path)
      assert.equal(full.status, 200)
      assert.equal(full.headers.get('content-type'), type)
      assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes)
      const head = await fetchAsset(path, { method: 'HEAD' })
      assert.equal(head.status, 200)
      assert.equal(head.headers.get('content-length'), String(bytes.length))
      assert.equal((await head.arrayBuffer()).byteLength, 0)
      const partial = await fetchAsset(path, { headers: { Range: 'bytes=0-7' } })
      assert.equal(partial.status, 206)
      assert.equal(partial.headers.get('content-range'), `bytes 0-7/${bytes.length}`)
      assert.equal(partial.headers.get('accept-ranges'), 'bytes')
      assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(0, 8))
    }
  })

  await t.test('uploaded PNGs and the frontend default SVG are served at the exact URLs returned by the API', async () => {
    const thumbnail = await fetchAsset(videos[1].thumbnailUrl)
    assert.equal(thumbnail.status, 200)
    assert.equal(thumbnail.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await thumbnail.arrayBuffer()), png)
    const fallback = await fetchAsset(videos[0].thumbnailUrl)
    assert.equal(fallback.status, 200)
    assert.match(fallback.headers.get('content-type'), /^image\/svg\+xml\b/)
    assert.equal(await fallback.text(), readFileSync(join(frontend, 'public/images/default-thumbnail.svg'), 'utf8'))
  })

  await t.test('API and missing upload errors remain backend JSON instead of successful SPA fallback HTML', async () => {
    const missing = await fetchAsset('/uploads/videos/90000000-0000-4000-8000-000000000009.mp4')
    assert.equal(missing.status, 404)
    assert.match(missing.headers.get('content-type'), /^application\/json\b/)
    assert.equal((await missing.json()).code, 'NOT_FOUND')
    await assert.rejects(learnerApi.learnerRequest('/api/videos/999999'), error => error.status === 404 && error.code === 'NOT_FOUND')
    await assert.rejects(learnerApi.learnerRequest('/api/videos?tagId=0'), error => error.status === 400 && error.code === 'VALIDATION_ERROR')
  })

  assert.deepEqual(snapshot(), before)
  assert.equal(database.isTransaction, false)
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})
