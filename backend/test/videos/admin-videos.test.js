import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const VISITOR = '11111111-1111-4111-8111-111111111111'
const VIDEO_KEYS = ['id', 'title', 'description', 'tags', 'videoUrl', 'thumbnailUrl', 'viewCount', 'likeCount',
  'likedByMe', 'commentCount', 'hasQuiz', 'createdAt', 'updatedAt']
const DETAIL_KEYS = [...VIDEO_KEYS, 'tagIds', 'videoPath', 'thumbnailPath', 'quiz']

test('관리자 영상 목록·편집 정보 API', { timeout: 60000 }, async t => {
  const { request, login, getDb } = await startAuthServer(t)
  const db = getDb()
  const { cookie } = await login()
  const get = (path, options = {}) => request(path, { cookie, ...options })

  const addTag = name => Number(db.prepare('INSERT INTO tags (name) VALUES (?)').run(name).lastInsertRowid)
  const addVideo = (title, { thumbnail = null, description = '' } = {}) => Number(db.prepare(
    'INSERT INTO videos (title, description, video_path, thumbnail_path) VALUES (?, ?, ?, ?)'
  ).run(title, description, `videos/${randomUUID()}.mp4`, thumbnail).lastInsertRowid)
  const tag = (videoId, tagId) => db.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(videoId, tagId)

  await t.test('로그인하지 않으면 목록·상세 모두 401이다', async () => {
    for (const path of ['/api/admin/videos', '/api/admin/videos/1', '/api/admin/videos?page=abc', '/api/admin/videos/abc']) {
      const res = await request(path)
      assert.equal(res.status, 401, path)
      assert.equal(res.json.code, 'AUTH_REQUIRED', path)
    }
  })

  await t.test('영상이 없으면 빈 목록이다', async () => {
    const res = await get('/api/admin/videos')
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { data: [], page: 1, limit: 20, total: 0 })
  })

  const excel = addTag('엑셀')
  const auto = addTag('업무자동화')
  const v1 = addVideo('단축키', { thumbnail: `thumbnails/${randomUUID()}.png`, description: '빠른 채우기' })
  const v2 = addVideo('자동 채우기')
  const v3 = addVideo('피벗 테이블')
  tag(v1, excel); tag(v1, auto); tag(v2, excel)

  await t.test('목록은 id 내림차순이고 영상 항목은 사용자용 Video와 같은 모양이다', async () => {
    const res = await get('/api/admin/videos')
    assert.equal(res.status, 200)
    assert.deepEqual(res.json.data.map(video => video.id), [v3, v2, v1])
    assert.deepEqual([res.json.page, res.json.limit, res.json.total], [1, 20, 3])
    for (const video of res.json.data) {
      assert.deepEqual(Object.keys(video), VIDEO_KEYS)
      assert.match(video.createdAt, ISO)
      assert.match(video.videoUrl, /^\/uploads\/videos\/[0-9a-f-]{36}\.mp4$/)
    }
    const first = res.json.data[2]
    assert.equal(first.description, '빠른 채우기')
    assert.match(first.thumbnailUrl, /^\/uploads\/thumbnails\//)
    assert.deepEqual(first.tags.map(item => item.name), ['업무자동화', '엑셀'], '태그는 이름순')
    assert.equal(res.json.data[1].thumbnailUrl, '/images/default-thumbnail.svg')
  })

  await t.test('관리자 목록의 likedByMe는 방문자 ID와 상관없이 false이다', async () => {
    db.prepare('INSERT INTO video_likes (video_id, visitor_id) VALUES (?, ?)').run(v1, VISITOR)
    const res = await get('/api/admin/videos', { headers: { 'X-Visitor-Id': VISITOR } })
    assert.ok(res.json.data.every(video => video.likedByMe === false))
    assert.equal(res.json.data.find(video => video.id === v1).likeCount, 1)
  })

  await t.test('page와 limit으로 나눠 가져오고, 범위를 넘으면 빈 목록이다', async () => {
    const second = await get('/api/admin/videos?limit=2&page=2')
    assert.deepEqual(second.json.data.map(video => video.id), [v1])
    assert.deepEqual([second.json.page, second.json.limit, second.json.total], [2, 2, 3])
    assert.deepEqual((await get('/api/admin/videos?page=99')).json.data, [])
    assert.equal((await get('/api/admin/videos?page=9007199254740991&limit=50')).status, 200)
  })

  await t.test('tagId로 걸러 내고, 총 개수도 필터 기준이다', async () => {
    const byExcel = await get(`/api/admin/videos?tagId=${excel}`)
    assert.deepEqual(byExcel.json.data.map(video => video.id), [v2, v1])
    assert.equal(byExcel.json.total, 2)
    const byAuto = await get(`/api/admin/videos?tagId=${auto}&limit=1`)
    assert.deepEqual([byAuto.json.data.map(video => video.id), byAuto.json.total], [[v1], 1])
    // 한 영상에 태그가 여러 개여도 목록에 한 번만 나온다
    assert.equal(byExcel.json.data.filter(video => video.id === v1).length, 1)
  })

  await t.test('존재하지 않는 tagId는 오류가 아니라 빈 목록이다', async () => {
    const res = await get('/api/admin/videos?tagId=999999')
    assert.equal(res.status, 200)
    assert.deepEqual([res.json.data, res.json.total], [[], 0])
  })

  await t.test('잘못된 page·limit·tagId는 400이다', async () => {
    for (const [query, field] of [
      ['page=0', 'page'], ['page=abc', 'page'], ['page=1.5', 'page'], ['page=', 'page'], ['page=1&page=2', 'page'],
      ['limit=0', 'limit'], ['limit=51', 'limit'], ['limit=', 'limit'],
      ['tagId=0', 'tagId'], ['tagId=-1', 'tagId'], ['tagId=abc', 'tagId'], ['tagId=1.5', 'tagId'], ['tagId=', 'tagId'],
      ['tagId=1&tagId=2', 'tagId'], ['tagId=9007199254740992', 'tagId'], ['tagId=1%3BDROP', 'tagId']
    ]) {
      const res = await get(`/api/admin/videos?${query}`)
      assert.equal(res.status, 400, query)
      assert.equal(res.json.code, 'VALIDATION_ERROR', query)
      assert.ok(res.json.fields[field], query)
    }
  })

  await t.test('편집 정보: Video 필드 뒤에 tagIds, videoPath, thumbnailPath, quiz가 붙는다', async () => {
    const res = await get(`/api/admin/videos/${v1}`)
    assert.equal(res.status, 200)
    assert.deepEqual(Object.keys(res.json), DETAIL_KEYS)
    assert.equal(res.json.id, v1)
    assert.deepEqual(res.json.tagIds, [excel, auto].sort((a, b) => a - b), '태그 ID는 번호순')
    assert.match(res.json.videoPath, /^videos\/[0-9a-f-]{36}\.mp4$/)
    assert.equal(res.json.videoUrl, `/uploads/${res.json.videoPath}`)
    assert.match(res.json.thumbnailPath, /^thumbnails\/[0-9a-f-]{36}\.png$/)
    assert.equal(res.json.thumbnailUrl, `/uploads/${res.json.thumbnailPath}`)
    assert.equal(res.json.quiz, null)
    assert.equal(res.json.hasQuiz, false)
  })

  await t.test('편집 정보: 썸네일이 없으면 thumbnailPath는 null이고 태그가 없으면 빈 배열이다', async () => {
    const res = await get(`/api/admin/videos/${v3}`)
    assert.equal(res.json.thumbnailPath, null)
    assert.equal(res.json.thumbnailUrl, '/images/default-thumbnail.svg')
    assert.deepEqual([res.json.tags, res.json.tagIds], [[], []])
  })

  await t.test('편집 정보: 퀴즈는 보기 순서대로 정답 표시와 함께 온다', async () => {
    const quizId = Number(db.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)').run(v2, '빠른 채우기 단축키는?').lastInsertRowid)
    const add = db.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
    add.run(quizId, 'Ctrl + R', 2, 0) // 일부러 순서를 뒤섞어 저장
    add.run(quizId, 'Ctrl + E', 1, 1)
    add.run(quizId, 'Ctrl + T', 3, 0)

    const res = await get(`/api/admin/videos/${v2}`)
    assert.equal(res.json.hasQuiz, true)
    assert.deepEqual(Object.keys(res.json.quiz), ['id', 'videoId', 'question', 'options'])
    assert.equal(res.json.quiz.videoId, v2)
    assert.equal(res.json.quiz.question, '빠른 채우기 단축키는?')
    assert.deepEqual(res.json.quiz.options.map(option => [option.content, option.sortOrder, option.isCorrect]),
      [['Ctrl + E', 1, true], ['Ctrl + R', 2, false], ['Ctrl + T', 3, false]])
    assert.deepEqual(Object.keys(res.json.quiz.options[0]), ['id', 'content', 'sortOrder', 'isCorrect'])
    assert.equal(typeof res.json.quiz.options[0].isCorrect, 'boolean')
  })

  await t.test('상세에 조회·좋아요·댓글 수가 반영된다', async () => {
    db.prepare('INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)').run(v1, VISITOR)
    db.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)').run(v1, '닉', 'x', '댓글')
    const res = await get(`/api/admin/videos/${v1}`)
    assert.deepEqual([res.json.viewCount, res.json.likeCount, res.json.commentCount, res.json.likedByMe], [1, 1, 1, false])
  })

  await t.test('없는 영상은 404, 잘못된 ID는 400이다', async () => {
    const missing = await get('/api/admin/videos/999999')
    assert.equal(missing.status, 404)
    assert.equal(missing.json.code, 'NOT_FOUND')
    for (const id of ['abc', '0', '-1', '1.5', '9007199254740992', '1%3BDROP%20TABLE%20videos']) {
      const res = await get(`/api/admin/videos/${id}`)
      assert.equal(res.status, 400, id)
      assert.ok(res.json.fields.id, id)
    }
    assert.equal((await get('/api/admin/videos')).json.total, 3, '조회가 데이터를 바꾸지 않는다')
  })

  await t.test('저장된 경로가 규칙에 맞지 않으면 내용을 숨긴 500으로 답한다', async () => {
    const broken = addVideo('깨진 경로')
    db.prepare('UPDATE videos SET video_path = ? WHERE id = ?').run('/etc/passwd', broken)
    const original = console.error
    console.error = () => {}
    try {
      for (const path of [`/api/admin/videos/${broken}`, '/api/admin/videos']) {
        const res = await get(path)
        assert.equal(res.status, 500, path)
        assert.deepEqual(res.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
        assert.equal(res.text.includes('passwd'), false)
      }
    } finally {
      console.error = original
    }
  })
})
