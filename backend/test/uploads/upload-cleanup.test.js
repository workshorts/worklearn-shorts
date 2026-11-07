import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { cleanupOrphanUploads, deleteUploads, scanUploads } from '../../src/lib/upload-cleanup.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { multipart } from '../helpers/multipart.js'
import { startAuthServer } from '../helpers/auth-server.js'

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const backend = fileURLToPath(new URL('../../', import.meta.url))
// 시험용 최소 파일: 형식을 알아볼 수 있는 시그니처만 담았다(재생 가능한 영상이 아니다).
const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')

const videoName = () => `videos/${randomUUID()}.mp4`
const thumbnailName = () => `thumbnails/${randomUUID()}.png`

// 임시 DB + 임시 업로드 폴더를 만든다.
function setup(t, name = 'cleanup.db') {
  const context = createDatabaseContext(t)
  const databasePath = context.path(name)
  context.initialize(databasePath)
  const uploadDir = context.path('uploads')
  mkdirSync(join(uploadDir, 'videos'), { recursive: true })
  mkdirSync(join(uploadDir, 'thumbnails'), { recursive: true })
  const database = context.open(databasePath)
  const put = (relativePath, { ageMs = 0, content = 'x' } = {}) => {
    const target = join(uploadDir, relativePath)
    writeFileSync(target, content)
    const time = new Date(Date.now() - ageMs)
    utimesSync(target, time, time)
    return target
  }
  const register = (videoPath, thumbnailPath = null) => database.prepare('INSERT INTO videos (title, video_path, thumbnail_path) VALUES (?, ?, ?)').run('등록된 영상', videoPath, thumbnailPath)
  const exists = relativePath => existsSync(join(uploadDir, relativePath))
  return { context, databasePath, uploadDir, database, put, register, exists }
}

test('분류: 영상이 쓰는 파일, 오래된 미등록 파일, 최근 파일, 건드리면 안 되는 항목을 구분한다', t => {
  const { database, uploadDir, put, register } = setup(t)
  const usedVideo = videoName(); const usedThumbnail = thumbnailName()
  const orphanVideo = videoName(); const orphanThumbnail = thumbnailName(); const young = videoName()
  put(usedVideo, { ageMs: 5 * DAY }); put(usedThumbnail, { ageMs: 5 * DAY })
  put(orphanVideo, { ageMs: 3 * DAY, content: 'a'.repeat(10) }); put(orphanThumbnail, { ageMs: 2 * DAY })
  put(young, { ageMs: 2 * HOUR })
  register(usedVideo, usedThumbnail)

  // 건드리면 안 되는 것들: 이름 규칙이 다른 파일, 점으로 시작하는 파일, 폴더, 링크
  put('videos/notes.txt', { ageMs: 9 * DAY }); put('videos/not-a-uuid.mp4', { ageMs: 9 * DAY }); put('thumbnails/.hidden', { ageMs: 9 * DAY })
  const folderPath = videoName()
  mkdirSync(join(uploadDir, folderPath))
  const linkPath = videoName()
  symlinkSync(join(uploadDir, usedVideo), join(uploadDir, linkPath))

  try {
    const report = scanUploads(database, uploadDir, { minAgeMs: DAY })
    assert.equal(report.used, 2)
    assert.equal(report.tooNew, 1)
    assert.deepEqual(report.candidates.map(file => file.path).sort(), [orphanThumbnail, orphanVideo].sort())
    assert.equal(report.candidates.find(file => file.path === orphanVideo).size, 10)
    assert.deepEqual(report.skipped.map(item => item.path).sort(), ['thumbnails/.hidden', 'videos/not-a-uuid.mp4', 'videos/notes.txt', folderPath, linkPath].sort())
    assert.ok(report.skipped.every(item => item.reason.length > 0))

    // 실제 정리를 해도 건드리면 안 되는 항목과 링크가 가리키는 파일은 그대로다
    const { applied } = cleanupOrphanUploads(database, uploadDir, { apply: true, minAgeMs: DAY })
    assert.deepEqual(applied.deleted.sort(), [orphanThumbnail, orphanVideo].sort())
    assert.equal(existsSync(join(uploadDir, linkPath)), true)
    assert.equal(existsSync(join(uploadDir, usedVideo)), true)
    assert.equal(existsSync(join(uploadDir, folderPath)), true)
    assert.equal(existsSync(join(uploadDir, 'videos/notes.txt')), true)
  } finally {
    unlinkSync(join(uploadDir, linkPath)) // 시험 도우미는 링크가 남아 있으면 임시 폴더 정리를 거절한다
  }
})

test('영상이 쓰는 파일은 아무리 오래돼도, DB에 대소문자가 다르게 저장돼 있어도 대상이 아니다', t => {
  const { database, uploadDir, put, register, exists } = setup(t)
  const path = videoName()
  put(path, { ageMs: 30 * DAY })
  register(path.replace(/[a-f]/g, letter => letter.toUpperCase())) // DB에는 대문자 UUID로 저장돼 있다
  assert.notEqual(path, path.replace(/[a-f]/g, letter => letter.toUpperCase()), '시험 전제: 경로의 대소문자가 실제로 다르다')

  const report = scanUploads(database, uploadDir, { minAgeMs: DAY })
  assert.deepEqual([report.used, report.candidates.length], [1, 0])
  const { applied } = cleanupOrphanUploads(database, uploadDir, { apply: true, minAgeMs: DAY })
  assert.deepEqual(applied.deleted, [])
  assert.equal(exists(path), true)
})

test('미리보기(apply: false)는 아무것도 지우지 않는다', t => {
  const { database, uploadDir, put, exists } = setup(t)
  const orphans = [videoName(), thumbnailName()]
  orphans.forEach(path => put(path, { ageMs: 5 * DAY }))
  const { scan, applied } = cleanupOrphanUploads(database, uploadDir, { minAgeMs: DAY })
  assert.equal(scan.candidates.length, 2)
  assert.equal(applied, null)
  assert.ok(orphans.every(exists))
})

test('실제 정리(apply: true)는 오래된 미등록 파일만 지우고 나머지는 그대로 둔다', t => {
  const { database, uploadDir, put, register, exists } = setup(t)
  const used = videoName(); const orphan = videoName(); const orphanThumb = thumbnailName(); const young = thumbnailName(); const unknown = 'videos/memo.txt'
  put(used, { ageMs: 9 * DAY }); put(orphan, { ageMs: 4 * DAY, content: 'a'.repeat(100) }); put(orphanThumb, { ageMs: 4 * DAY, content: 'b'.repeat(50) })
  put(young, { ageMs: 30 * 60 * 1000 }); put(unknown, { ageMs: 9 * DAY })
  register(used)

  const { applied } = cleanupOrphanUploads(database, uploadDir, { apply: true, minAgeMs: DAY })
  assert.deepEqual(applied.deleted.sort(), [orphan, orphanThumb].sort())
  assert.equal(applied.freedBytes, 150)
  assert.deepEqual([applied.skipped, applied.failed], [[], []])
  assert.deepEqual([exists(orphan), exists(orphanThumb)], [false, false])
  assert.deepEqual([exists(used), exists(young), exists(unknown)], [true, true, true])

  const again = cleanupOrphanUploads(database, uploadDir, { apply: true, minAgeMs: DAY })
  assert.deepEqual([again.scan.candidates, again.applied.deleted], [[], []], '다시 실행해도 더 지울 게 없다')
})

test('minAge를 줄이면 최근 파일도 대상이 되고, 늘리면 오래된 파일도 보호된다', t => {
  const { database, uploadDir, put } = setup(t)
  const path = videoName()
  put(path, { ageMs: 3 * HOUR })
  assert.equal(scanUploads(database, uploadDir, { minAgeMs: DAY }).candidates.length, 0)
  assert.equal(scanUploads(database, uploadDir, { minAgeMs: HOUR }).candidates.length, 1)
  put(videoName(), { ageMs: 5 * DAY })
  assert.equal(scanUploads(database, uploadDir, { minAgeMs: 30 * DAY }).candidates.length, 0)
})

test('경쟁 상황: 훑은 뒤에 영상에 연결되거나, 다시 수정되거나, 사라진 파일은 지우지 않는다', t => {
  const { database, uploadDir, put, register, exists } = setup(t)
  const registeredMeanwhile = videoName(); const touchedMeanwhile = videoName(); const resizedMeanwhile = videoName(); const goneMeanwhile = videoName(); const plain = videoName()
  for (const path of [registeredMeanwhile, touchedMeanwhile, resizedMeanwhile, goneMeanwhile, plain]) put(path, { ageMs: 5 * DAY })
  const { candidates } = scanUploads(database, uploadDir, { minAgeMs: DAY })
  assert.equal(candidates.length, 5)

  register(registeredMeanwhile) // 관리자가 이제야 이 파일로 영상을 등록했다
  put(touchedMeanwhile, { ageMs: 0 }) // 누군가 같은 이름 파일을 다시 썼다(수정 시각이 바뀜)
  put(resizedMeanwhile, { ageMs: 5 * DAY, content: '내용이 길어짐' }) // 크기가 바뀜
  unlinkSync(join(uploadDir, goneMeanwhile)) // 다른 곳에서 먼저 지움

  const result = deleteUploads(database, uploadDir, candidates)
  assert.deepEqual(result.deleted, [plain])
  assert.deepEqual(result.skipped.map(item => [item.path, item.reason]).sort(), [
    [goneMeanwhile, '이미 사라짐'], [registeredMeanwhile, '그 사이 영상에 연결됨'], [resizedMeanwhile, '훑은 뒤에 파일이 바뀜'], [touchedMeanwhile, '훑은 뒤에 파일이 바뀜']
  ].sort())
  assert.deepEqual([registeredMeanwhile, touchedMeanwhile, resizedMeanwhile].map(exists), [true, true, true])
})

test('폴더가 없거나 비어 있어도 오류 없이 빈 결과이다', t => {
  const { database, context } = setup(t)
  const missing = context.path('no-such-uploads')
  assert.deepEqual(scanUploads(database, missing, { minAgeMs: DAY }), { used: 0, tooNew: 0, skipped: [], candidates: [] })
  mkdirSync(missing)
  assert.equal(cleanupOrphanUploads(database, missing, { apply: true, minAgeMs: DAY }).applied.deleted.length, 0)
})

test('API 통합: 실제로 올린 파일 중 등록된 영상의 파일은 남고, 오래된 미등록 파일만 지워지며, 서버는 계속 정상이다', { timeout: 60000 }, async t => {
  const { request, login, uploadDir, getDb } = await startAuthServer(t, { uploads: true })
  const { cookie } = await login()
  const db = getDb()
  const upload = async (kind, data) => {
    const { body, contentType } = multipart([{ name: 'kind', data: kind }, { name: 'file', filename: 'x.bin', data }])
    const res = await request('/api/admin/uploads', { method: 'POST', body, headers: { 'Content-Type': contentType }, cookie })
    assert.equal(res.status, 201, res.text)
    return res.json.path
  }
  const age = (path, ageMs) => { const time = new Date(Date.now() - ageMs); utimesSync(join(uploadDir, path), time, time) }

  const registeredVideo = await upload('video', MP4)
  const registeredThumb = await upload('thumbnail', PNG)
  const abandonedVideo = await upload('video', MP4)
  const abandonedThumb = await upload('thumbnail', PNG)
  const freshVideo = await upload('video', MP4) // 방금 올려 아직 등록 전
  const created = await request('/api/admin/videos', { method: 'POST', cookie, body: { title: '등록한 영상', videoPath: registeredVideo, thumbnailPath: registeredThumb } })
  assert.equal(created.status, 201)
  for (const path of [registeredVideo, registeredThumb, abandonedVideo, abandonedThumb]) age(path, 10 * DAY) // 등록된 파일도 오래됐다

  const { applied } = cleanupOrphanUploads(db, uploadDir, { apply: true, minAgeMs: DAY })
  assert.deepEqual(applied.deleted.sort(), [abandonedVideo, abandonedThumb].sort())
  assert.equal(existsSync(join(uploadDir, registeredVideo)), true)
  assert.equal(existsSync(join(uploadDir, freshVideo)), true)

  assert.equal((await request(`/uploads/${registeredVideo}`)).status, 200, '등록된 영상은 그대로 재생된다')
  assert.equal((await request(`/uploads/${abandonedVideo}`)).status, 404)
  const registeredLater = await request('/api/admin/videos', { method: 'POST', cookie, body: { title: '나중에 등록', videoPath: freshVideo } })
  assert.equal(registeredLater.status, 201, '보류했던 최근 파일은 정리 뒤에도 등록할 수 있다')
  const lost = await request('/api/admin/videos', { method: 'POST', cookie, body: { title: '정리된 파일로 등록', videoPath: abandonedVideo } })
  assert.equal(lost.status, 400, '이미 정리된 파일로는 등록할 수 없다(파일을 찾을 수 없음)')
})

test('명령: 기본은 미리보기이고 --apply를 붙여야 지우며, 잘못된 옵션과 초기화 안 된 DB는 알기 쉬운 메시지로 실패한다', { timeout: 60000 }, t => {
  const { context, databasePath, uploadDir, put, exists } = setup(t, 'cli.db')
  const orphan = videoName(); const young = thumbnailName()
  put(orphan, { ageMs: 4 * DAY, content: 'a'.repeat(2048) }); put(young, { ageMs: HOUR })
  mkdirSync(join(uploadDir, '.incoming'), { recursive: true })
  const stale = join('.incoming', `${randomUUID()}.part`); const freshPart = join('.incoming', `${randomUUID()}.part`)
  put(stale, { ageMs: 5 * HOUR }); put(freshPart, { ageMs: 60 * 1000 })

  const run = (...args) => spawnSync(process.execPath, [join(backend, 'scripts', 'cleanup-uploads.js'), ...args], {
    cwd: context.directory, encoding: 'utf8', timeout: 25000,
    env: { ...process.env, NODE_NO_WARNINGS: '1', DB_PATH: databasePath, UPLOAD_DIR: uploadDir, NODE_TEST_CONTEXT: undefined }
  })

  const preview = run()
  assert.equal(preview.status, 0, preview.stderr)
  assert.match(preview.stdout, /정리 대상\(미등록\) 1개, 합계 2\.0KB/)
  assert.ok(preview.stdout.includes(orphan))
  assert.match(preview.stdout, /최근 올려서 보류 1개/)
  assert.match(preview.stdout, /\[미리보기\] 아무것도 지우지 않았습니다/)
  assert.equal(exists(orphan), true)

  const applied = run('--apply')
  assert.equal(applied.status, 0, applied.stderr)
  assert.match(applied.stdout, /삭제 완료: 1개, 2\.0KB 확보 \/ 중단된 업로드 임시 파일 1개도 정리/)
  assert.deepEqual([exists(orphan), exists(young), exists(stale), exists(freshPart)], [false, true, false, true])
  assert.match(run().stdout, /정리할 파일이 없습니다/)

  for (const args of [['--bogus'], ['--min-age-hours=0.5'], ['--min-age-hours=abc'], ['--min-age-hours='], ['--min-age-hours=100000']]) {
    const bad = run(...args)
    assert.equal(bad.status, 1, args.join(' '))
    assert.match(bad.stderr, /사용법: npm run uploads:cleanup/)
    assert.equal(bad.stdout, '')
  }
  assert.match(run('--min-age-hours=1').stdout, /마지막 수정이 1시간 넘은/)

  const notReady = spawnSync(process.execPath, [join(backend, 'scripts', 'cleanup-uploads.js')], {
    cwd: context.directory, encoding: 'utf8', timeout: 25000,
    env: { ...process.env, NODE_NO_WARNINGS: '1', DB_PATH: context.path('never-created.db'), UPLOAD_DIR: uploadDir, NODE_TEST_CONTEXT: undefined }
  })
  assert.equal(notReady.status, 1)
  assert.match(notReady.stderr, /npm run db:init/)
  assert.equal(notReady.stderr.includes(databasePath), false, '내부 경로를 노출하지 않는다')
  assert.equal(/at .*\.js:\d+/.test(notReady.stderr), false, '오류 스택을 노출하지 않는다')
})
