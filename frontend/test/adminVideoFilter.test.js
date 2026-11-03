import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import { startAuthServer } from '../../backend/test/helpers/auth-server.js'
import { createDatabaseContext } from '../../backend/test/helpers/database-context.js'
import * as preview from '../src/api/mockVideoApi.js'

// 실제 videoApi 모듈을 Vite로 읽어 실제 서버와 임시 DB에 연결한다.
test('관리자 영상 필터: 실제 요청 함수의 호환성·조건·페이지 경계', async t => {
  const { request, login, getDb } = await startAuthServer(t, { uploads: true })
  const context = createDatabaseContext(t)
  const vite = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, envDir: false,
    logLevel: 'silent', cacheDir: context.path('vite-cache'),
    define: { 'import.meta.env.VITE_ADMIN_PREVIEW': '"false"' },
    server: { watch: null, hmr: false, preTransformRequests: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  context.addCleanup(() => vite.close())
  const { getVideos, getTags, deleteVideo } = await vite.ssrLoadModule('/src/api/videoApi.js')
  const { cookie } = await login()
  const calls = []
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    calls.push(path)
    const response = await request(path, { method: options.method, body: options.body,
      headers: { ...options.headers, Origin: 'http://localhost:5173' }, cookie })
    return new Response(response.status === 204 ? null : response.text, { status: response.status, headers: response.headers })
  })
  const db = getDb()
  const tagIds = ['엑셀', '개발', '빈 태그'].map(name => Number(db.prepare('INSERT INTO tags (name) VALUES (?)').run(name).lastInsertRowid))
  const ids = []
  for (let i = 0; i < 24; i++) {
    const id = Number(db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)').run(`영상 ${i + 1}`, `videos/${randomUUID()}.mp4`).lastInsertRowid)
    ids.push(id)
    if (i < 23) db.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(id, i < 21 ? tagIds[0] : tagIds[1])
  }
  await t.test('기존 두 인수 호출은 태그 없는 영상을 포함한 전체 목록', async () => {
    const result = await getVideos(1, new AbortController().signal)
    assert.equal(result.total, 24)
    assert.equal(result.data.length, 20)
    assert.equal(new URL(calls.at(-1), 'http://local').searchParams.has('tagId'), false)
    assert.equal((await getTags()).data.length, 3)
  })
  await t.test('필터 적용 후 total과 두 페이지의 영상 ID가 정확하다', async () => {
    const first = await getVideos(1, undefined, tagIds[0])
    assert.equal(first.total, 21)
    assert.equal(first.data.length, 20)
    assert.ok(first.data.every(video => video.tags.some(tag => tag.id === tagIds[0])))
    const second = await getVideos(2, undefined, tagIds[0])
    assert.deepEqual(second.data.map(video => video.id), [ids[0]])
    assert.equal(second.page, 2)
    assert.equal(new URL(calls.at(-1), 'http://local').searchParams.get('tagId'), String(tagIds[0]))
  })
  await t.test('빈 태그와 전체 보기 복원', async () => {
    const result = await getVideos(1, undefined, tagIds[2])
    assert.deepEqual(result.data, [])
    assert.equal(result.total, 0)
    assert.equal((await getVideos(1, undefined, null)).total, 24)
  })
  await t.test('필터 마지막 페이지 영상 삭제 후 이전 페이지 데이터 재조회', async () => {
    await deleteVideo(ids[0])
    assert.equal((await getVideos(2, undefined, tagIds[0])).data.length, 0)
    const result = await getVideos(1, undefined, tagIds[0])
    assert.equal(result.total, 20)
    assert.equal(result.data.length, 20)
  })
})

test('미리보기 필터도 페이지 자르기 전에 적용하고 전체 개수를 유지한다', async () => {
  for (let i = 0; i < 20; i++) await preview.saveVideo(null, { title: `필터 샘플 ${i}`, description: '', tagIds: [1], quiz: null })
  const first = await preview.getVideos(1, undefined, 1)
  const second = await preview.getVideos(2, undefined, 1)
  assert.equal(first.total, 22)
  assert.equal(first.data.length, 20)
  assert.equal(second.total, 22)
  assert.equal(second.data.length, 2)
  assert.ok([...first.data, ...second.data].every(video => video.tagIds.includes(1)))
  assert.equal(new Set([...first.data, ...second.data].map(video => video.id)).size, 22)
  assert.equal((await preview.getVideos(1)).total, 28)
  assert.deepEqual((await preview.getVideos(1, undefined, 999)).data, [])
  const controller = new AbortController(); controller.abort()
  await assert.rejects(preview.getVideos(1, controller.signal, 1), error => error.name === 'AbortError')
})
