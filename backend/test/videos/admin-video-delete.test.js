import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'
import { multipart } from '../helpers/multipart.js'

// 시험용 최소 파일: 형식을 알아볼 수 있는 시그니처만 담았다(재생 가능한 영상이 아니다).
const SAMPLES = {
  mp4: Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex'),
  png: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
}
const QUIZ = { question: '빠른 채우기 단축키는?', options: [{ content: 'Ctrl + E', isCorrect: true }, { content: 'Ctrl + R', isCorrect: false }] }
const VISITOR = '11111111-1111-4111-8111-111111111111'

test('관리자 영상 삭제 API', { timeout: 60000 }, async t => {
  const { request, login, uploadDir, getDb } = await startAuthServer(t, { uploads: true })
  const { cookie } = await login()
  const db = getDb()

  // 시험이 실제 backend/uploads를 건드리지 않는지 확인한다(설정 모듈은 서버를 만든 뒤에 불러온다).
  const { config } = await import('../../src/config/index.js')
  assert.equal(config.uploadDir, uploadDir)

  const upload = async (kind, data) => {
    const { body, contentType } = multipart([{ name: 'kind', data: kind }, { name: 'file', filename: 'x.bin', data }])
    const res = await request('/api/admin/uploads', { method: 'POST', body, headers: { 'Content-Type': contentType }, cookie })
    assert.equal(res.status, 201, res.text)
    return res.json.path
  }
  const create = async (extra = {}) => {
    const res = await request('/api/admin/videos', { method: 'POST', cookie, body: { title: '삭제할 영상', videoPath: await upload('video', SAMPLES.mp4), ...extra } })
    assert.equal(res.status, 201, res.text)
    return res.json
  }
  const del = (id, options = {}) => request(`/api/admin/videos/${id}`, {
    method: 'DELETE', cookie: options.cookie === undefined ? cookie : options.cookie, headers: options.headers
  })
  const exists = path => existsSync(join(uploadDir, path))
  const one = (sql, ...values) => db.prepare(sql).get(...values)
  const addTag = name => Number(db.prepare('INSERT INTO tags (name) VALUES (?)').run(name).lastInsertRowid)
  const addCourse = (name, videoIds) => {
    const id = Number(db.prepare('INSERT INTO courses (name, description) VALUES (?, ?)').run(name, '').lastInsertRowid)
    videoIds.forEach((videoId, index) => db.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)').run(id, videoId, index + 1))
    return id
  }
  const courseOrder = courseId => db.prepare('SELECT video_id, sort_order FROM course_videos WHERE course_id = ? ORDER BY sort_order').all(courseId).map(row => [row.video_id, row.sort_order])

  const excel = addTag('엑셀')

  await t.test('로그인 없이 401, 다른 Origin 403이고 영상은 그대로 남는다', async () => {
    const video = await create()
    assert.equal((await del(video.id, { cookie: '' })).status, 401)
    const evil = await del(video.id, { headers: { Origin: 'http://evil.example' } })
    assert.equal(evil.status, 403)
    assert.equal(evil.json.code, 'ORIGIN_FORBIDDEN')
    assert.equal((await request(`/api/admin/videos/${video.id}`, { cookie })).status, 200)
    assert.equal(exists(video.videoPath), true)
  })

  await t.test('잘못된 ID는 400, 없는 영상은 404이다', async () => {
    for (const id of ['abc', '0', '-1', '1.5', '9007199254740992', '1%3BDROP%20TABLE%20videos']) {
      const res = await del(id)
      assert.equal(res.status, 400, id)
      assert.ok(res.json.fields.id, id)
    }
    const missing = await del(999999)
    assert.equal(missing.status, 404)
    assert.equal(missing.json.code, 'NOT_FOUND')
  })

  await t.test('삭제하면 204와 빈 본문이고, 이후 조회·목록에서 사라지며 다시 지우면 404이다', async () => {
    const keep = await create({ title: '남겨 둘 영상' })
    const video = await create()
    const before = (await request('/api/admin/videos', { cookie })).json.total
    const res = await del(video.id)
    assert.equal(res.status, 204)
    assert.equal(res.text, '')
    assert.equal((await request(`/api/admin/videos/${video.id}`, { cookie })).status, 404)
    const list = await request('/api/admin/videos', { cookie })
    assert.equal(list.json.total, before - 1)
    assert.equal(list.json.data.some(item => item.id === video.id), false)
    assert.equal(list.json.data.some(item => item.id === keep.id), true)
    assert.equal((await del(video.id)).status, 404, '이미 지운 영상은 404')
  })

  await t.test('태그·과정 연결·조회·좋아요·댓글·퀴즈·보기가 함께 삭제되고, 태그와 과정 자체는 남는다', async () => {
    const other = await create({ tagIds: [excel], quiz: QUIZ })
    const video = await create({ tagIds: [excel], quiz: QUIZ, thumbnailPath: await upload('thumbnail', SAMPLES.png) })
    const course = addCourse('엑셀 입문', [video.id, other.id])
    db.prepare('INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)').run(video.id, VISITOR)
    db.prepare('INSERT INTO video_likes (video_id, visitor_id) VALUES (?, ?)').run(video.id, VISITOR)
    db.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)').run(video.id, '닉', 'x', '댓글')
    db.prepare('INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)').run(other.id, VISITOR)
    const optionsOf = id => one('SELECT COUNT(*) AS n FROM quiz_options WHERE quiz_id IN (SELECT id FROM quizzes WHERE video_id = ?)', id).n

    assert.equal((await del(video.id)).status, 204)
    for (const table of ['video_tags', 'course_videos', 'video_views', 'video_likes', 'comments', 'quizzes']) {
      assert.equal(one(`SELECT COUNT(*) AS n FROM ${table} WHERE video_id = ?`, video.id).n, 0, table)
    }
    assert.equal(optionsOf(video.id), 0, '퀴즈 보기도 함께 삭제')
    assert.equal(one('SELECT COUNT(*) AS n FROM tags WHERE id = ?', excel).n, 1, '태그 자체는 남는다')
    assert.equal(one('SELECT COUNT(*) AS n FROM courses WHERE id = ?', course).n, 1, '과정 자체는 남는다')

    // 다른 영상의 데이터는 그대로다
    assert.equal(one('SELECT COUNT(*) AS n FROM video_tags WHERE video_id = ?', other.id).n, 1)
    assert.equal(one('SELECT COUNT(*) AS n FROM video_views WHERE video_id = ?', other.id).n, 1)
    assert.equal(optionsOf(other.id), 2)
    assert.deepEqual((await request(`/api/admin/videos/${other.id}`, { cookie })).json.quiz, other.quiz)
  })

  await t.test('영상이 빠진 과정은 남은 영상의 순서를 1부터 빈틈없이 다시 매기고, 사용자 화면에서도 보이지 않는다', async () => {
    const [a, b, c, d] = [await create(), await create(), await create(), await create()]
    const first = addCourse('앞을 지우는 과정', [a.id, b.id, c.id])
    const middle = addCourse('가운데를 지우는 과정', [b.id, a.id, d.id, c.id])
    const unrelated = addCourse('상관 없는 과정', [c.id, d.id])
    const beforeUnrelated = courseOrder(unrelated)

    assert.equal((await del(a.id)).status, 204)
    assert.deepEqual(courseOrder(first), [[b.id, 1], [c.id, 2]], '맨 앞 영상을 지우면 다음 영상이 1번이 된다')
    assert.deepEqual(courseOrder(middle), [[b.id, 1], [d.id, 2], [c.id, 3]], '가운데 영상을 지워도 상대 순서는 그대로')
    assert.deepEqual(courseOrder(unrelated), beforeUnrelated, '관련 없는 과정은 그대로')

    const detail = await request(`/api/courses/${first}`)
    assert.deepEqual(detail.json.videos.map(video => [video.id, video.sortOrder]), [[b.id, 1], [c.id, 2]])
    assert.equal(detail.json.videoCount, 2)

    // 과정의 영상을 모두 지우면 빈 과정이다(명세: 삭제 후 빈 과정이면 [])
    await del(b.id)
    await del(c.id)
    const emptied = await request(`/api/courses/${first}`)
    assert.deepEqual([emptied.status, emptied.json.videos, emptied.json.videoCount], [200, [], 0])
  })

  await t.test('영상·썸네일 파일이 디스크에서 지워지고, 다른 영상의 파일은 그대로이다', async () => {
    const bystander = await create({ thumbnailPath: await upload('thumbnail', SAMPLES.png) })
    const withThumbnail = await create({ thumbnailPath: await upload('thumbnail', SAMPLES.png) })
    const withoutThumbnail = await create()

    assert.equal((await del(withThumbnail.id)).status, 204)
    assert.equal(exists(withThumbnail.videoPath), false)
    assert.equal(exists(withThumbnail.thumbnailPath), false)
    assert.equal((await del(withoutThumbnail.id)).status, 204, '썸네일이 없어도 정상')
    assert.equal(exists(withoutThumbnail.videoPath), false)
    assert.equal(exists(bystander.videoPath), true)
    assert.equal(exists(bystander.thumbnailPath), true)
  })

  await t.test('파일 정리는 안전하다: 규칙에 어긋난 경로, 링크, 이미 없는 파일, 다른 영상이 쓰는 파일은 지우지 않는다', async () => {
    // (1) 저장된 경로가 규칙에 어긋난 비정상 데이터: 업로드 폴더 밖 파일을 지우면 안 된다
    const outside = join(uploadDir, '..', 'outside-file.txt')
    writeFileSync(outside, '지우면 안 되는 파일')
    const weird = await create()
    db.prepare('UPDATE videos SET video_path = ? WHERE id = ?').run('../outside-file.txt', weird.id)
    assert.equal((await del(weird.id)).status, 204)
    assert.equal(existsSync(outside), true)

    // (2) 경로가 링크인 경우: 링크도, 링크가 가리키는 파일도 지우지 않는다
    const target = await upload('video', SAMPLES.mp4)
    const linkPath = `videos/${randomUUID()}.mp4`
    symlinkSync(join(uploadDir, target), join(uploadDir, linkPath))
    const linked = await create()
    db.prepare('UPDATE videos SET video_path = ? WHERE id = ?').run(linkPath, linked.id)
    try {
      assert.equal((await del(linked.id)).status, 204)
      assert.equal(exists(target), true)
      assert.equal(existsSync(join(uploadDir, linkPath)), true)
    } finally {
      unlinkSync(join(uploadDir, linkPath)) // 시험 도우미는 링크가 남아 있으면 임시 폴더 정리를 거절한다
    }

    // (3) 파일이 이미 디스크에 없는 경우: 오류 없이 삭제된다
    const missing = await create()
    unlinkSync(join(uploadDir, missing.videoPath))
    assert.equal((await del(missing.id)).status, 204)

    // (4) 다른 영상이 같은 경로를 쓰고 있는 비정상 데이터: 그 파일은 지우지 않는다
    const owner = await create()
    db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)').run('같은 파일을 쓰는 영상', owner.videoPath)
    assert.equal((await del(owner.id)).status, 204)
    assert.equal(exists(owner.videoPath), true)
  })

  await t.test('삭제 도중 오류가 나면 모두 되돌리고 파일도 지우지 않는다(과정 순서도 그대로)', async () => {
    const [x, y] = [await create({ tagIds: [excel], quiz: QUIZ }), await create()]
    const course = addCourse('롤백 확인 과정', [x.id, y.id])
    const before = (await request(`/api/admin/videos/${x.id}`, { cookie })).json
    db.exec("CREATE TRIGGER block_video_delete BEFORE DELETE ON videos BEGIN SELECT RAISE(ABORT, '삭제 막음'); END") // 삭제 단계를 일부러 실패시킨다
    const original = console.error
    console.error = () => {}
    try {
      const res = await del(x.id)
      assert.equal(res.status, 500)
      assert.deepEqual(res.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
    } finally {
      console.error = original
      db.exec('DROP TRIGGER block_video_delete')
    }
    assert.deepEqual((await request(`/api/admin/videos/${x.id}`, { cookie })).json, before, '영상·태그·퀴즈가 그대로')
    assert.deepEqual(courseOrder(course), [[x.id, 1], [y.id, 2]])
    assert.equal(exists(x.videoPath), true, '삭제가 실패했으니 파일을 지우지 않는다')
    assert.equal((await del(x.id)).status, 204, '문제를 없앤 뒤 다시 삭제하면 성공')
  })

  await t.test('같은 영상을 동시에 지우면 하나만 204이고 나머지는 404이다', async () => {
    const video = await create({ thumbnailPath: await upload('thumbnail', SAMPLES.png) })
    const results = await Promise.all(Array.from({ length: 6 }, () => del(video.id)))
    assert.deepEqual(results.map(res => res.status).sort(), [204, 404, 404, 404, 404, 404])
    assert.equal(exists(video.videoPath), false)
    assert.equal(exists(video.thumbnailPath), false)
  })

  await t.test('삭제는 업로드 중 임시 파일이나 다른 폴더를 건드리지 않는다', async () => {
    const incoming = join(uploadDir, '.incoming')
    const marker = join(incoming, `${randomUUID()}.part`)
    writeFileSync(marker, '받는 중인 파일')
    const video = await create()
    assert.equal((await del(video.id)).status, 204)
    assert.equal(existsSync(marker), true)
    unlinkSync(marker)
  })
})
