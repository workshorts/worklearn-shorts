import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const VISITOR_A = '11111111-1111-4111-8111-111111111111'
const VISITOR_B = '22222222-2222-4222-8222-222222222222'
const VIDEO_KEYS = ['id', 'title', 'description', 'tags', 'videoUrl', 'thumbnailUrl', 'viewCount', 'likeCount',
  'likedByMe', 'commentCount', 'hasQuiz', 'createdAt', 'updatedAt', 'sortOrder']

function addVideo(db, title, { thumbnail = null, path = `videos/${randomUUID()}.mp4` } = {}) {
  return Number(db.prepare('INSERT INTO videos (title, description, video_path, thumbnail_path) VALUES (?, ?, ?, ?)')
    .run(title, `${title} 설명`, path, thumbnail).lastInsertRowid)
}

function addCourse(db, name, videoIds = []) {
  const id = Number(db.prepare('INSERT INTO courses (name, description) VALUES (?, ?)').run(name, `${name} 소개`).lastInsertRowid)
  videoIds.forEach((videoId, index) => {
    db.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)').run(id, videoId, index + 1)
  })
  return id
}

test('학습과정 조회 API', { timeout: 60000 }, async t => {
  const { request, getDb } = await startAuthServer(t)
  const db = getDb()

  await t.test('과정이 없으면 빈 목록을 돌려준다', async () => {
    const res = await request('/api/courses')
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { data: [], page: 1, limit: 20, total: 0 })
  })

  const excel = db.prepare('INSERT INTO tags (name) VALUES (?)').run('엑셀').lastInsertRowid
  const auto = db.prepare('INSERT INTO tags (name) VALUES (?)').run('업무자동화').lastInsertRowid
  const v1 = addVideo(db, '단축키', { thumbnail: `thumbnails/${randomUUID()}.png` })
  const v2 = addVideo(db, '자동 채우기')
  const v3 = addVideo(db, '피벗 테이블')
  db.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(v1, auto)
  db.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(v1, excel)
  const courseA = addCourse(db, '엑셀 입문', [v2, v1, v3]) // 일부러 영상 번호 순서와 다르게
  const courseB = addCourse(db, '자동화 맛보기', [v1])
  const courseEmpty = addCourse(db, '준비 중인 과정')

  await t.test('목록은 id 내림차순이고 영상 수와 정해진 필드만 담는다', async () => {
    const res = await request('/api/courses')
    assert.equal(res.status, 200)
    assert.deepEqual(res.json.data.map(course => course.id), [courseEmpty, courseB, courseA])
    assert.deepEqual(res.json.data.map(course => course.videoCount), [0, 1, 3])
    assert.deepEqual(Object.keys(res.json.data[0]), ['id', 'name', 'description', 'videoCount', 'createdAt', 'updatedAt'])
    assert.match(res.json.data[0].createdAt, ISO)
    assert.match(res.json.data[0].updatedAt, ISO)
    assert.deepEqual([res.json.page, res.json.limit, res.json.total], [1, 20, 3])
  })

  await t.test('page와 limit으로 나눠 가져오고, 범위를 넘으면 빈 목록이다', async () => {
    const second = await request('/api/courses?limit=1&page=2')
    assert.equal(second.status, 200)
    assert.deepEqual(second.json.data.map(course => course.id), [courseB])
    assert.deepEqual([second.json.page, second.json.limit, second.json.total], [2, 1, 3])

    const beyond = await request('/api/courses?page=99')
    assert.equal(beyond.status, 200)
    assert.deepEqual([beyond.json.data, beyond.json.total], [[], 3])

    const huge = await request('/api/courses?page=9007199254740991&limit=50')
    assert.equal(huge.status, 200)
    assert.deepEqual(huge.json.data, [])

    assert.equal((await request('/api/courses?limit=50')).status, 200)
  })

  await t.test('잘못된 page와 limit은 400이다', async () => {
    for (const [query, field] of [
      ['page=0', 'page'], ['page=-1', 'page'], ['page=abc', 'page'], ['page=1.5', 'page'], ['page=', 'page'],
      ['page=1&page=2', 'page'], ['limit=0', 'limit'], ['limit=51', 'limit'], ['limit=abc', 'limit'], ['limit=', 'limit']
    ]) {
      const res = await request(`/api/courses?${query}`)
      assert.equal(res.status, 400, query)
      assert.equal(res.json.code, 'VALIDATION_ERROR', query)
      assert.ok(res.json.fields[field], query)
    }
  })

  await t.test('목록은 방문자 ID를 읽지 않으므로 잘못된 헤더가 있어도 성공한다', async () => {
    const res = await request('/api/courses', { headers: { 'X-Visitor-Id': 'not-a-uuid' } })
    assert.equal(res.status, 200)
  })

  await t.test('상세는 영상을 학습 순서(sortOrder)대로 담는다', async () => {
    const res = await request(`/api/courses/${courseA}`)
    assert.equal(res.status, 200)
    assert.equal(res.json.id, courseA)
    assert.equal(res.json.name, '엑셀 입문')
    assert.equal(res.json.description, '엑셀 입문 소개')
    assert.equal(res.json.videoCount, 3)
    assert.match(res.json.createdAt, ISO)
    assert.deepEqual(res.json.videos.map(video => video.id), [v2, v1, v3])
    assert.deepEqual(res.json.videos.map(video => video.sortOrder), [1, 2, 3])
    assert.deepEqual(Object.keys(res.json), ['id', 'name', 'description', 'videoCount', 'createdAt', 'updatedAt', 'videos'])
  })

  await t.test('상세의 영상 항목은 영상 API와 같은 모양이다', async () => {
    const res = await request(`/api/courses/${courseA}`)
    const [first, second] = res.json.videos
    assert.deepEqual(Object.keys(first).sort(), [...VIDEO_KEYS].sort())
    assert.match(first.videoUrl, /^\/uploads\/videos\/[0-9a-f-]{36}\.mp4$/)
    assert.equal(first.thumbnailUrl, '/images/default-thumbnail.svg') // 썸네일이 없으면 기본 이미지
    assert.match(second.thumbnailUrl, /^\/uploads\/thumbnails\/[0-9a-f-]{36}\.png$/)
    // 한글 이름순에서는 '업무자동화'(ㅓ)가 '엑셀'(ㅔ)보다 앞이다. 태그 목록 API와 같은 기준이다.
    assert.deepEqual(second.tags, [{ id: Number(auto), name: '업무자동화' }, { id: Number(excel), name: '엑셀' }], '태그는 이름순')
    assert.deepEqual(first.tags, [])
    assert.deepEqual([first.viewCount, first.likeCount, first.likedByMe, first.commentCount, first.hasQuiz], [0, 0, false, 0, false])
    assert.match(first.createdAt, ISO)
  })

  await t.test('조회·좋아요·댓글·퀴즈 값과 방문자별 likedByMe를 반영한다', async () => {
    db.prepare('INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)').run(v1, VISITOR_A)
    db.prepare('INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)').run(v1, VISITOR_B)
    db.prepare('INSERT INTO video_likes (video_id, visitor_id) VALUES (?, ?)').run(v1, VISITOR_A)
    db.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)').run(v1, '닉', 'x', '댓글')
    db.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)').run(v1, '닉2', 'x', '댓글2')
    db.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)').run(v1, '질문?')

    const find = res => res.json.videos.find(video => video.id === v1)
    const anonymous = find(await request(`/api/courses/${courseA}`))
    assert.deepEqual([anonymous.viewCount, anonymous.likeCount, anonymous.likedByMe, anonymous.commentCount, anonymous.hasQuiz], [2, 1, false, 2, true])

    const liker = find(await request(`/api/courses/${courseA}`, { headers: { 'X-Visitor-Id': VISITOR_A } }))
    assert.equal(liker.likedByMe, true)
    const other = find(await request(`/api/courses/${courseA}`, { headers: { 'X-Visitor-Id': VISITOR_B.toUpperCase() } }))
    assert.equal(other.likedByMe, false)
  })

  await t.test('같은 영상이 여러 과정에 들어가 있어도 과정마다 따로 보이고, 영상을 지우면 모두에서 빠진다', async () => {
    const inB = await request(`/api/courses/${courseB}`)
    assert.deepEqual(inB.json.videos.map(video => [video.id, video.sortOrder]), [[v1, 1]])

    db.prepare('DELETE FROM videos WHERE id = ?').run(v1)
    const afterA = await request(`/api/courses/${courseA}`)
    assert.deepEqual(afterA.json.videos.map(video => video.id), [v2, v3])
    assert.equal(afterA.json.videoCount, 2)
    const afterB = await request(`/api/courses/${courseB}`)
    assert.deepEqual([afterB.json.videos, afterB.json.videoCount], [[], 0])
    const list = await request('/api/courses')
    assert.deepEqual(list.json.data.map(course => course.videoCount), [0, 0, 2])
  })

  await t.test('영상이 없는 과정도 정상 응답이다', async () => {
    const res = await request(`/api/courses/${courseEmpty}`)
    assert.equal(res.status, 200)
    assert.deepEqual([res.json.videos, res.json.videoCount], [[], 0])
  })

  await t.test('없는 과정은 404, 잘못된 ID와 방문자 ID는 400이다', async () => {
    const missing = await request('/api/courses/999999')
    assert.equal(missing.status, 404)
    assert.equal(missing.json.code, 'NOT_FOUND')

    for (const id of ['abc', '0', '-1', '1.5', '9007199254740992', '1%3BDROP%20TABLE%20courses']) {
      const res = await request(`/api/courses/${id}`)
      assert.equal(res.status, 400, id)
      assert.equal(res.json.code, 'VALIDATION_ERROR', id)
      assert.ok(res.json.fields.id, id)
    }

    const badVisitor = await request(`/api/courses/${courseA}`, { headers: { 'X-Visitor-Id': 'not-a-uuid' } })
    assert.equal(badVisitor.status, 400)
    assert.ok(badVisitor.json.fields.visitorId)
    assert.equal((await request('/api/courses')).json.total, 3, '요청이 데이터를 바꾸지 않는다')
  })

  await t.test('저장된 영상 경로가 규칙에 맞지 않으면 내용을 숨긴 500으로 답한다', async () => {
    const broken = addVideo(db, '깨진 경로', { path: '/etc/passwd' })
    const course = addCourse(db, '깨진 과정', [broken])
    const original = console.error
    console.error = () => {}
    try {
      const res = await request(`/api/courses/${course}`)
      assert.equal(res.status, 500)
      assert.deepEqual(res.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
      assert.equal(res.text.includes('passwd'), false)
    } finally {
      console.error = original
    }
  })
})
