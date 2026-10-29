import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'
import { multipart } from '../helpers/multipart.js'

// 시험용 최소 파일: 형식을 알아볼 수 있는 시그니처만 담았다(재생 가능한 영상이 아니다).
const SAMPLES = {
  mp4: Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex'),
  webm: Buffer.from('1a45dfa3874282847765626d', 'hex'),
  png: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'),
  jpg: Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')
}
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const KEYS = ['id', 'title', 'description', 'tags', 'videoUrl', 'thumbnailUrl', 'viewCount', 'likeCount', 'likedByMe',
  'commentCount', 'hasQuiz', 'createdAt', 'updatedAt', 'tagIds', 'videoPath', 'thumbnailPath', 'quiz']
const QUIZ = { question: '빠른 채우기 단축키는?', options: [{ content: 'Ctrl + E', isCorrect: true }, { content: 'Ctrl + R', isCorrect: false }] }

test('관리자 영상 등록 API', { timeout: 60000 }, async t => {
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
  const post = (body, options = {}) => request('/api/admin/videos', {
    method: 'POST', body, cookie: options.cookie === undefined ? cookie : options.cookie, headers: options.headers
  })
  const count = table => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
  const snapshot = () => ['videos', 'video_tags', 'quizzes', 'quiz_options'].map(count)
  const addTag = name => Number(db.prepare('INSERT INTO tags (name) VALUES (?)').run(name).lastInsertRowid)
  const freshVideo = async () => ({ title: '새 영상', videoPath: await upload('video', SAMPLES.mp4) })

  const excel = addTag('엑셀')
  const auto = addTag('업무자동화')

  await t.test('로그인하지 않으면 401, 허용되지 않은 Origin은 403, JSON이 아니면 415이다', async () => {
    const body = await freshVideo()
    const before = snapshot()
    const anonymous = await post(body, { cookie: '' })
    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.json.code, 'AUTH_REQUIRED')
    const evil = await post(body, { headers: { Origin: 'http://evil.example' } })
    assert.equal(evil.status, 403)
    assert.equal(evil.json.code, 'ORIGIN_FORBIDDEN')
    const text = await post('x', { headers: { 'Content-Type': 'text/plain' } })
    assert.equal(text.status, 415)
    assert.deepEqual(snapshot(), before)
  })

  await t.test('잘못된 JSON은 400 INVALID_JSON, 객체가 아닌 본문은 400이다', async () => {
    const broken = await post('{bad')
    assert.equal(broken.status, 400)
    assert.equal(broken.json.code, 'INVALID_JSON')
    const array = await post([])
    assert.equal(array.status, 400)
    assert.ok(array.json.fields.body)
  })

  await t.test('최소 입력(제목+영상)으로 등록하면 201과 기본값이 채워진 AdminVideo를 돌려준다', async () => {
    const videoPath = await upload('video', SAMPLES.mp4)
    const res = await post({ title: '엑셀 단축키', videoPath })
    assert.equal(res.status, 201)
    assert.deepEqual(Object.keys(res.json), KEYS)
    assert.match(res.json.createdAt, ISO)
    assert.equal(res.json.description, '')
    assert.deepEqual([res.json.tags, res.json.tagIds], [[], []])
    assert.equal(res.json.videoPath, videoPath)
    assert.equal(res.json.videoUrl, `/uploads/${videoPath}`)
    assert.equal(res.json.thumbnailPath, null)
    assert.equal(res.json.thumbnailUrl, '/images/default-thumbnail.svg')
    assert.equal(res.json.quiz, null)
    assert.deepEqual([res.json.viewCount, res.json.likeCount, res.json.commentCount, res.json.hasQuiz, res.json.likedByMe], [0, 0, 0, false, false])
    assert.equal(res.headers.location, `/api/admin/videos/${res.json.id}`)

    // 등록 직후 편집 정보 조회와 같은 내용이다
    const detail = await request(`/api/admin/videos/${res.json.id}`, { cookie })
    assert.deepEqual(detail.json, res.json)
    const list = await request('/api/admin/videos', { cookie })
    assert.equal(list.json.data[0].id, res.json.id, '새 영상이 목록 맨 앞에 보인다')
  })

  await t.test('태그·썸네일·퀴즈를 함께 등록하면 한 번에 저장된다', async () => {
    const videoPath = await upload('video', SAMPLES.webm)
    const thumbnailPath = await upload('thumbnail', SAMPLES.png)
    const before = snapshot()
    const res = await post({ title: '퀴즈가 있는 영상', description: '설명', tagIds: [auto, excel], videoPath, thumbnailPath, quiz: QUIZ })
    assert.equal(res.status, 201)
    assert.deepEqual(res.json.tagIds, [excel, auto].sort((a, b) => a - b))
    assert.deepEqual(res.json.tags.map(tag => tag.name), ['업무자동화', '엑셀'])
    assert.equal(res.json.thumbnailPath, thumbnailPath)
    assert.equal(res.json.thumbnailUrl, `/uploads/${thumbnailPath}`)
    assert.equal(res.json.hasQuiz, true)
    assert.deepEqual(Object.keys(res.json.quiz), ['id', 'videoId', 'question', 'options'])
    assert.equal(res.json.quiz.videoId, res.json.id)
    assert.deepEqual(res.json.quiz.options.map(option => [option.content, option.sortOrder, option.isCorrect]),
      [['Ctrl + E', 1, true], ['Ctrl + R', 2, false]], '배열 순서가 보기 순서')
    assert.deepEqual(snapshot(), [before[0] + 1, before[1] + 2, before[2] + 1, before[3] + 2])
  })

  await t.test('제목·퀴즈의 앞뒤 공백은 지워서 저장한다', async () => {
    const videoPath = await upload('video', SAMPLES.mp4)
    const res = await post({
      title: '   공백이 있는 제목   ', videoPath,
      quiz: { question: '  질문  ', options: [{ content: '  가  ', isCorrect: false }, { content: ' 나 ', isCorrect: true }] }
    })
    assert.equal(res.status, 201)
    assert.equal(res.json.title, '공백이 있는 제목')
    assert.equal(res.json.quiz.question, '질문')
    assert.deepEqual(res.json.quiz.options.map(option => option.content), ['가', '나'])
  })

  await t.test('글자 수는 DB와 같게 유니코드 문자 단위로 센다(이모지 100개는 통과, 101개는 거절)', async () => {
    const ok = await post({ title: '😀'.repeat(100), videoPath: await upload('video', SAMPLES.mp4) })
    assert.equal(ok.status, 201)
    assert.equal([...ok.json.title].length, 100)
    const tooLong = await post({ title: '😀'.repeat(101), videoPath: await upload('video', SAMPLES.mp4) })
    assert.equal(tooLong.status, 400)
    assert.ok(tooLong.json.fields.title)
  })

  await t.test('필드 오류는 한꺼번에 모아서 400으로 돌려주고 아무것도 저장하지 않는다', async () => {
    const before = snapshot()
    const res = await post({
      title: 'a', description: 'x'.repeat(501), videoPath: '../etc/passwd', thumbnailPath: 'videos/' + randomUUID() + '.mp4',
      tagIds: [1, 1], quiz: { question: '', options: [{ content: '하나', isCorrect: true }] }
    })
    assert.equal(res.status, 400)
    assert.equal(res.json.code, 'VALIDATION_ERROR')
    for (const key of ['title', 'description', 'videoPath', 'thumbnailPath', 'tagIds', 'quiz.question', 'quiz.options']) {
      assert.ok(res.json.fields[key], key)
    }
    assert.deepEqual(snapshot(), before)
  })

  await t.test('제목·설명·경로·태그 입력 오류 모음', async () => {
    const valid = 'videos/11111111-1111-4111-8111-111111111111.mp4'
    const cases = [
      ['제목 없음', { videoPath: valid }, 'title'],
      ['제목 숫자', { title: 123, videoPath: valid }, 'title'],
      ['제목 공백뿐', { title: '    ', videoPath: valid }, 'title'],
      ['제목 1자', { title: '가', videoPath: valid }, 'title'],
      ['제목 101자', { title: '가'.repeat(101), videoPath: valid }, 'title'],
      ['제목에 널 문자', { title: '제목\0제목', videoPath: valid }, 'title'],
      ['설명 null', { title: '제목', description: null, videoPath: valid }, 'description'],
      ['설명 숫자', { title: '제목', description: 5, videoPath: valid }, 'description'],
      ['영상 경로 없음', { title: '제목' }, 'videoPath'],
      ['영상 경로 숫자', { title: '제목', videoPath: 5 }, 'videoPath'],
      ['외부 주소', { title: '제목', videoPath: 'https://example.com/a.mp4' }, 'videoPath'],
      ['절대 경로', { title: '제목', videoPath: '/uploads/' + valid }, 'videoPath'],
      ['폴더 이동', { title: '제목', videoPath: 'videos/../videos/11111111-1111-4111-8111-111111111111.mp4' }, 'videoPath'],
      ['UUID 아님', { title: '제목', videoPath: 'videos/a.mp4' }, 'videoPath'],
      ['허용 안 되는 확장자', { title: '제목', videoPath: 'videos/11111111-1111-4111-8111-111111111111.gif' }, 'videoPath'],
      ['끝에 줄바꿈', { title: '제목', videoPath: valid + '\n' }, 'videoPath'],
      ['영상 자리에 썸네일 경로', { title: '제목', videoPath: 'thumbnails/11111111-1111-4111-8111-111111111111.png' }, 'videoPath'],
      ['썸네일 숫자', { title: '제목', videoPath: valid, thumbnailPath: 5 }, 'thumbnailPath'],
      ['썸네일 자리에 영상 경로', { title: '제목', videoPath: valid, thumbnailPath: valid }, 'thumbnailPath'],
      ['태그 문자열', { title: '제목', videoPath: valid, tagIds: '1' }, 'tagIds'],
      ['태그 null', { title: '제목', videoPath: valid, tagIds: null }, 'tagIds'],
      ['태그 중복', { title: '제목', videoPath: valid, tagIds: [1, 1] }, 'tagIds'],
      ['태그 0', { title: '제목', videoPath: valid, tagIds: [0] }, 'tagIds'],
      ['태그 음수', { title: '제목', videoPath: valid, tagIds: [-1] }, 'tagIds'],
      ['태그 소수', { title: '제목', videoPath: valid, tagIds: [1.5] }, 'tagIds'],
      ['태그 문자', { title: '제목', videoPath: valid, tagIds: ['1'] }, 'tagIds'],
      ['태그 101개', { title: '제목', videoPath: valid, tagIds: Array.from({ length: 101 }, (_, index) => index + 1) }, 'tagIds']
    ]
    const before = snapshot()
    for (const [label, body, field] of cases) {
      const res = await post(body)
      assert.equal(res.status, 400, label)
      assert.equal(res.json.code, 'VALIDATION_ERROR', label)
      assert.ok(res.json.fields[field], `${label}: ${JSON.stringify(res.json.fields)}`)
    }
    assert.deepEqual(snapshot(), before)
  })

  await t.test('퀴즈 입력 오류 모음', async () => {
    const valid = 'videos/11111111-1111-4111-8111-111111111111.mp4'
    const option = (content, isCorrect) => ({ content, isCorrect })
    const cases = [
      ['퀴즈 문자열', 'x', 'quiz'],
      ['퀴즈 배열', [], 'quiz'],
      ['질문 없음', { options: [option('가', true), option('나', false)] }, 'quiz.question'],
      ['질문 공백뿐', { question: '  ', options: [option('가', true), option('나', false)] }, 'quiz.question'],
      ['질문 201자', { question: '가'.repeat(201), options: [option('가', true), option('나', false)] }, 'quiz.question'],
      ['보기 없음', { question: '질문' }, 'quiz.options'],
      ['보기 1개', { question: '질문', options: [option('가', true)] }, 'quiz.options'],
      ['보기 6개', { question: '질문', options: Array.from({ length: 6 }, (_, index) => option(`보기${index}`, index === 0)) }, 'quiz.options'],
      ['보기 객체 아님', { question: '질문', options: ['가', '나'] }, 'quiz.options[0]'],
      ['보기 내용 빈 값', { question: '질문', options: [option('', true), option('나', false)] }, 'quiz.options[0].content'],
      ['보기 내용 101자', { question: '질문', options: [option('가'.repeat(101), true), option('나', false)] }, 'quiz.options[0].content'],
      ['정답 없음', { question: '질문', options: [option('가', false), option('나', false)] }, 'quiz.options'],
      ['정답 2개', { question: '질문', options: [option('가', true), option('나', true)] }, 'quiz.options'],
      ['isCorrect 문자열', { question: '질문', options: [option('가', 'true'), option('나', false)] }, 'quiz.options[0].isCorrect'],
      ['isCorrect 없음', { question: '질문', options: [{ content: '가' }, option('나', true)] }, 'quiz.options[0].isCorrect'],
      ['퀴즈 알 수 없는 필드', { question: '질문', hint: 'x', options: [option('가', true), option('나', false)] }, 'quiz.hint'],
      ['보기 알 수 없는 필드', { question: '질문', options: [{ content: '가', isCorrect: true, id: 5 }, option('나', false)] }, 'quiz.options[0].id']
    ]
    const before = snapshot()
    for (const [label, quiz, field] of cases) {
      const res = await post({ title: '제목', videoPath: valid, quiz })
      assert.equal(res.status, 400, label)
      assert.equal(res.json.code, 'VALIDATION_ERROR', label)
      assert.ok(res.json.fields[field], `${label}: ${JSON.stringify(res.json.fields)}`)
    }
    const maxOptions = await post({ title: '제목', videoPath: await upload('video', SAMPLES.mp4), quiz: { question: '질문', options: Array.from({ length: 5 }, (_, index) => option(`보기${index}`, index === 4)) } })
    assert.equal(maxOptions.status, 201, '보기 5개는 허용')
    assert.equal(maxOptions.json.quiz.options[4].isCorrect, true)
    assert.equal(snapshot()[0], before[0] + 1)
  })

  await t.test('명세에 없는 필드(과정 연결 등)는 400으로 거절하고, __proto__로 객체를 오염시키지 못한다', async () => {
    const videoPath = await upload('video', SAMPLES.mp4)
    const extra = await post({ title: '제목', videoPath, courseIds: [1], pathId: 1, id: 99, createdAt: 'x' })
    assert.equal(extra.status, 400)
    for (const key of ['courseIds', 'pathId', 'id', 'createdAt']) assert.ok(extra.json.fields[key], key)

    const proto = await post(`{"title":"제목","videoPath":"${videoPath}","__proto__":{"isAdmin":true}}`, { headers: { 'Content-Type': 'application/json' } })
    assert.equal(proto.status, 400)
    assert.ok(proto.json.fields.__proto__)
    assert.equal({}.isAdmin, undefined)
  })

  await t.test('존재하지 않는 태그는 400이고 저장하지 않는다', async () => {
    const before = snapshot()
    const res = await post({ title: '제목', videoPath: await upload('video', SAMPLES.mp4), tagIds: [excel, 999999] })
    assert.equal(res.status, 400)
    assert.equal(res.json.code, 'VALIDATION_ERROR')
    assert.match(res.json.fields.tagIds, /999999/)
    assert.deepEqual(snapshot(), before)
  })

  await t.test('업로드하지 않은 파일, 형식이 다른 파일, 링크 파일은 400으로 거절한다', async () => {
    const before = snapshot()
    const ghost = `videos/${randomUUID()}.mp4`
    const missing = await post({ title: '제목', videoPath: ghost })
    assert.equal(missing.status, 400)
    assert.ok(missing.json.fields.videoPath)
    assert.equal(missing.text.includes(uploadDir), false, '내부 경로를 노출하지 않는다')

    const fake = `videos/${randomUUID()}.mp4`
    writeFileSync(join(uploadDir, fake), '영상이 아닌 글자')
    assert.ok((await post({ title: '제목', videoPath: fake })).json.fields.videoPath)

    const wrongExtension = `thumbnails/${randomUUID()}.jpg`
    writeFileSync(join(uploadDir, wrongExtension), SAMPLES.png) // 내용은 PNG인데 .jpg 이름
    const videoPath = await upload('video', SAMPLES.mp4)
    const thumb = await post({ title: '제목', videoPath, thumbnailPath: wrongExtension })
    assert.equal(thumb.status, 400)
    assert.ok(thumb.json.fields.thumbnailPath)
    assert.equal(thumb.json.fields.videoPath, undefined, '문제 있는 파일만 짚어 준다')

    const linkPath = `videos/${randomUUID()}.mp4`
    symlinkSync(join(uploadDir, videoPath), join(uploadDir, linkPath))
    try {
      assert.ok((await post({ title: '제목', videoPath: linkPath })).json.fields.videoPath)
    } finally {
      unlinkSync(join(uploadDir, linkPath)) // 시험 도우미는 링크가 남아 있으면 임시 폴더 정리를 거절한다
    }
    assert.deepEqual(snapshot(), before)
  })

  await t.test('같은 영상·썸네일 파일을 다시 쓰면 409 FILE_ALREADY_USED이다(대소문자만 다른 이름도 같은 파일로 본다)', async () => {
    const videoPath = await upload('video', SAMPLES.mp4)
    const thumbnailPath = await upload('thumbnail', SAMPLES.jpg)
    assert.equal((await post({ title: '첫 영상', videoPath, thumbnailPath })).status, 201)
    const before = snapshot()

    const sameVideo = await post({ title: '다른 영상', videoPath })
    assert.equal(sameVideo.status, 409)
    assert.equal(sameVideo.json.code, 'FILE_ALREADY_USED')
    assert.ok(sameVideo.json.fields.videoPath)

    const sameThumbnail = await post({ title: '다른 영상', videoPath: await upload('video', SAMPLES.mp4), thumbnailPath })
    assert.equal(sameThumbnail.status, 409)
    assert.ok(sameThumbnail.json.fields.thumbnailPath)

    const caseVariant = await upload('video', SAMPLES.webm)
    db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)').run('대문자 경로', caseVariant.toUpperCase().replace('VIDEOS/', 'videos/'))
    const beforeCase = snapshot()
    const sameFile = await post({ title: '다른 영상', videoPath: caseVariant })
    assert.equal(sameFile.status, 409)
    assert.equal(snapshot()[0], beforeCase[0])
    assert.equal(before[0] + 1, beforeCase[0], '거절된 요청은 영상을 만들지 않는다')
  })

  await t.test('같은 파일을 동시에 등록하면 하나만 성공한다', async () => {
    const videoPath = await upload('video', SAMPLES.mp4)
    const before = count('videos')
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => post({ title: `동시 등록 ${index}`, videoPath })))
    assert.deepEqual(results.map(res => res.status).sort(), [201, 409, 409, 409, 409, 409])
    assert.equal(count('videos'), before + 1)
  })

  await t.test('저장 도중 오류가 나면 영상·태그·퀴즈를 모두 되돌린다', async () => {
    const videoPath = await upload('video', SAMPLES.mp4)
    const before = snapshot()
    db.exec('ALTER TABLE quiz_options RENAME TO quiz_options_held') // 퀴즈 보기 저장 단계를 일부러 실패시킨다
    const original = console.error
    console.error = () => {}
    try {
      const res = await post({ title: '되돌려질 영상', tagIds: [excel], videoPath, quiz: QUIZ })
      assert.equal(res.status, 500)
      assert.deepEqual(res.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
    } finally {
      console.error = original
      db.exec('ALTER TABLE quiz_options_held RENAME TO quiz_options')
    }
    assert.deepEqual(snapshot(), before, '영상 행도 남지 않는다')
    // 되돌린 뒤 같은 파일로 다시 등록할 수 있다
    assert.equal((await post({ title: '다시 등록', videoPath })).status, 201)
  })

  await t.test('등록 요청은 업로드 폴더의 파일을 지우거나 옮기지 않는다', async () => {
    const files = () => ['videos', 'thumbnails'].flatMap(directory => (existsSync(join(uploadDir, directory)) ? readdirSync(join(uploadDir, directory)) : []))
    const videoPath = await upload('video', SAMPLES.mp4)
    const before = files().sort()
    await post({ title: '정상', videoPath })
    await post({ title: 'a', videoPath }) // 제목 오류
    assert.deepEqual(files().sort(), before)
  })
})
