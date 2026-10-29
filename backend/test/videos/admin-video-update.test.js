import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
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
const QUIZ = { question: '빠른 채우기 단축키는?', options: [{ content: 'Ctrl + E', isCorrect: true }, { content: 'Ctrl + R', isCorrect: false }] }
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

test('관리자 영상 수정 API', { timeout: 90000 }, async t => {
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
    const res = await request('/api/admin/videos', { method: 'POST', cookie, body: { title: '원래 제목', videoPath: await upload('video', SAMPLES.mp4), ...extra } })
    assert.equal(res.status, 201, res.text)
    return res.json
  }
  const patch = (id, body, options = {}) => request(`/api/admin/videos/${id}`, {
    method: 'PATCH', body, cookie: options.cookie === undefined ? cookie : options.cookie, headers: options.headers
  })
  const detail = async id => (await request(`/api/admin/videos/${id}`, { cookie })).json
  const exists = path => existsSync(join(uploadDir, path))
  const addTag = name => Number(db.prepare('INSERT INTO tags (name) VALUES (?)').run(name).lastInsertRowid)
  const count = table => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
  // 같은 서버를 여러 시험이 함께 쓰므로, 퀴즈 개수는 해당 영상 것만 센다.
  const quizRows = videoId => ({
    quizzes: db.prepare('SELECT COUNT(*) AS count FROM quizzes WHERE video_id = ?').get(videoId).count,
    options: db.prepare('SELECT COUNT(*) AS count FROM quiz_options WHERE quiz_id IN (SELECT id FROM quizzes WHERE video_id = ?)').get(videoId).count
  })

  const excel = addTag('엑셀')
  const auto = addTag('업무자동화')
  const manner = addTag('비즈니스 매너')

  await t.test('로그인 없이 401, 다른 Origin 403, JSON 아님 415, 잘못된 JSON 400이다', async () => {
    const video = await create()
    assert.equal((await patch(video.id, { title: '바꾼 제목' }, { cookie: '' })).status, 401)
    const evil = await patch(video.id, { title: '바꾼 제목' }, { headers: { Origin: 'http://evil.example' } })
    assert.equal(evil.status, 403)
    assert.equal(evil.json.code, 'ORIGIN_FORBIDDEN')
    assert.equal((await patch(video.id, 'x', { headers: { 'Content-Type': 'text/plain' } })).status, 415)
    const broken = await patch(video.id, '{bad')
    assert.equal(broken.status, 400)
    assert.equal(broken.json.code, 'INVALID_JSON')
    assert.equal((await detail(video.id)).title, '원래 제목', '거절된 요청은 아무것도 바꾸지 않는다')
  })

  await t.test('잘못된 ID는 400이고, 없는 영상은 404이다(입력 오류가 먼저)', async () => {
    for (const id of ['abc', '0', '1.5', '-1', '9007199254740992']) {
      const res = await patch(id, { title: '제목입니다' })
      assert.equal(res.status, 400, id)
      assert.ok(res.json.fields.id, id)
    }
    const missing = await patch(999999, { title: '제목입니다' })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.code, 'NOT_FOUND')
    assert.equal((await patch(999999, { title: 'a' })).status, 400, '본문 오류가 있으면 영상 존재 여부보다 먼저 400')
  })

  await t.test('빈 PATCH, 객체가 아닌 본문, 명세에 없는 필드는 400이다', async () => {
    const video = await create()
    const before = await detail(video.id)
    const empty = await patch(video.id, {})
    assert.equal(empty.status, 400)
    assert.ok(empty.json.fields.body)
    assert.ok((await patch(video.id, [])).json.fields.body)
    const extra = await patch(video.id, { title: '제목입니다', courseIds: [1], id: 9, createdAt: 'x', likeCount: 5 })
    assert.equal(extra.status, 400)
    for (const key of ['courseIds', 'id', 'createdAt', 'likeCount']) assert.ok(extra.json.fields[key], key)
    assert.deepEqual(await detail(video.id), before)
  })

  await t.test('null은 thumbnailPath와 quiz에서만 허용하고 나머지 필드는 400이다', async () => {
    const video = await create()
    const before = await detail(video.id)
    for (const field of ['title', 'description', 'videoPath', 'tagIds']) {
      const res = await patch(video.id, { [field]: null })
      assert.equal(res.status, 400, field)
      assert.ok(res.json.fields[field], field)
    }
    assert.equal((await patch(video.id, { thumbnailPath: null })).status, 200)
    assert.equal((await patch(video.id, { quiz: null })).status, 200)
    assert.deepEqual(await detail(video.id), before)
  })

  await t.test('필드 값 오류는 등록과 같은 규칙으로 한꺼번에 400이다', async () => {
    const video = await create()
    const before = await detail(video.id)
    const res = await patch(video.id, {
      title: 'a', description: 'x'.repeat(501), videoPath: '../etc/passwd', thumbnailPath: 'videos/' + randomUUID() + '.mp4',
      tagIds: [1, 1], quiz: { question: '', options: [{ content: '하나', isCorrect: true }] }
    })
    assert.equal(res.status, 400)
    for (const key of ['title', 'description', 'videoPath', 'thumbnailPath', 'tagIds', 'quiz.question', 'quiz.options']) assert.ok(res.json.fields[key], key)
    assert.deepEqual(await detail(video.id), before)
  })

  await t.test('제목만 보내면 제목만 바뀌고 나머지와 생성 시각은 그대로이며 updatedAt이 갱신된다', async () => {
    const video = await create({ description: '설명', tagIds: [excel], quiz: QUIZ })
    await pause(15)
    const res = await patch(video.id, { title: '  바꾼 제목  ' })
    assert.equal(res.status, 200)
    assert.deepEqual(Object.keys(res.json), Object.keys(video))
    assert.equal(res.json.title, '바꾼 제목')
    for (const key of ['description', 'tagIds', 'videoPath', 'thumbnailPath', 'createdAt']) assert.deepEqual(res.json[key], video[key], key)
    assert.deepEqual(res.json.quiz, video.quiz, '퀴즈는 생략하면 그대로(번호도 그대로)')
    assert.ok(res.json.updatedAt > video.updatedAt)
    assert.deepEqual(await detail(video.id), res.json, '응답이 편집 정보 조회와 같다')
  })

  await t.test('설명은 빈 문자열로도 바꿀 수 있다', async () => {
    const video = await create({ description: '설명이 있다' })
    const res = await patch(video.id, { description: '' })
    assert.equal(res.status, 200)
    assert.equal(res.json.description, '')
  })

  await t.test('값이 하나도 바뀌지 않으면 아무것도 저장하지 않고 updatedAt도 그대로이다(폼이 모든 필드를 보내도)', async () => {
    const video = await create({ description: '설명', tagIds: [excel, auto], quiz: QUIZ })
    await pause(15)
    // AdminVideoForm은 수정 때 모든 필드를 항상 보낸다.
    const res = await patch(video.id, {
      title: video.title, description: video.description, tagIds: [auto, excel], videoPath: video.videoPath,
      thumbnailPath: video.thumbnailPath, quiz: { question: QUIZ.question, options: QUIZ.options }
    })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, video, 'updatedAt, 퀴즈 번호까지 그대로')
  })

  await t.test('태그는 전체를 교체하고 []이면 모두 제거한다', async () => {
    const video = await create({ tagIds: [excel, auto] })
    const replaced = await patch(video.id, { tagIds: [manner] })
    assert.deepEqual([replaced.status, replaced.json.tagIds], [200, [manner]])
    assert.deepEqual(replaced.json.tags.map(tag => tag.name), ['비즈니스 매너'])
    const cleared = await patch(video.id, { tagIds: [] })
    assert.deepEqual([cleared.status, cleared.json.tagIds, cleared.json.tags], [200, [], []])
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_tags WHERE video_id = ?').get(video.id).count, 0)
  })

  await t.test('없는 태그나 중복 태그는 400이고 기존 태그를 그대로 둔다', async () => {
    const video = await create({ tagIds: [excel] })
    const unknown = await patch(video.id, { title: '바뀌면 안 되는 제목', tagIds: [auto, 999999] })
    assert.equal(unknown.status, 400)
    assert.match(unknown.json.fields.tagIds, /999999/)
    assert.equal((await patch(video.id, { tagIds: [auto, auto] })).status, 400)
    const after = await detail(video.id)
    assert.deepEqual([after.title, after.tagIds], ['원래 제목', [excel]], '같은 요청의 제목 변경도 함께 되돌려진다')
  })

  await t.test('퀴즈: 추가, 교체, 같은 내용 재전송(번호 유지), 삭제', async () => {
    const video = await create()
    const added = await patch(video.id, { quiz: QUIZ })
    assert.equal(added.status, 200)
    assert.equal(added.json.hasQuiz, true)
    assert.deepEqual(added.json.quiz.options.map(option => [option.content, option.sortOrder, option.isCorrect]), [['Ctrl + E', 1, true], ['Ctrl + R', 2, false]])

    const same = await patch(video.id, { quiz: { question: QUIZ.question, options: QUIZ.options } })
    assert.deepEqual(same.json.quiz, added.json.quiz, '같은 내용이면 퀴즈 번호도 그대로')

    const replaced = await patch(video.id, { quiz: { question: '새 질문', options: [{ content: '가', isCorrect: false }, { content: '나', isCorrect: false }, { content: '다', isCorrect: true }] } })
    assert.equal(replaced.json.quiz.question, '새 질문')
    assert.deepEqual(replaced.json.quiz.options.map(option => option.content), ['가', '나', '다'])
    assert.deepEqual(quizRows(video.id), { quizzes: 1, options: 3 }, '옛 퀴즈는 남지 않는다')

    const removed = await patch(video.id, { quiz: null })
    assert.deepEqual([removed.status, removed.json.quiz, removed.json.hasQuiz], [200, null, false])
    assert.deepEqual(quizRows(video.id), { quizzes: 0, options: 0 }, '보기까지 함께 삭제된다')
    assert.equal((await patch(video.id, { quiz: null })).status, 200, '이미 없는 퀴즈를 null로 지워도 정상')
  })

  await t.test('잘못된 퀴즈는 400이고 기존 퀴즈를 그대로 둔다', async () => {
    const video = await create({ quiz: QUIZ })
    const bad = await patch(video.id, { quiz: { question: '질문', options: [{ content: '가', isCorrect: true }, { content: '나', isCorrect: true }] } })
    assert.equal(bad.status, 400)
    assert.ok(bad.json.fields['quiz.options'])
    assert.deepEqual((await detail(video.id)).quiz, video.quiz)
  })

  await t.test('썸네일: 새 파일로 바꾸면 옛 파일이 지워지고, null이면 기본 이미지로 돌아가며 옛 파일이 지워진다', async () => {
    const first = await upload('thumbnail', SAMPLES.png)
    const video = await create({ thumbnailPath: first })
    const second = await upload('thumbnail', SAMPLES.jpg)

    const replaced = await patch(video.id, { thumbnailPath: second })
    assert.equal(replaced.status, 200)
    assert.equal(replaced.json.thumbnailPath, second)
    assert.equal(replaced.json.thumbnailUrl, `/uploads/${second}`)
    assert.equal(exists(first), false, '옛 썸네일 파일은 지워진다')
    assert.equal(exists(second), true)

    const removed = await patch(video.id, { thumbnailPath: null })
    assert.deepEqual([removed.json.thumbnailPath, removed.json.thumbnailUrl], [null, '/images/default-thumbnail.svg'])
    assert.equal(exists(second), false)
    assert.equal((await patch(video.id, { thumbnailPath: null })).status, 200, '이미 기본 이미지여도 정상')
  })

  await t.test('영상 파일을 바꾸면 새 파일이 검사되고 옛 영상 파일이 지워진다', async () => {
    const video = await create()
    const next = await upload('video', SAMPLES.webm)
    const res = await patch(video.id, { videoPath: next })
    assert.equal(res.status, 200)
    assert.equal(res.json.videoPath, next)
    assert.equal(res.json.videoUrl, `/uploads/${next}`)
    assert.equal(exists(video.videoPath), false)
    assert.equal(exists(next), true)
  })

  await t.test('업로드하지 않은 파일, 형식이 다른 파일은 400이고 아무것도 바뀌지 않는다', async () => {
    const thumbnailPath = await upload('thumbnail', SAMPLES.png)
    const video = await create({ thumbnailPath })
    const before = await detail(video.id)
    const ghost = await patch(video.id, { title: '바뀌면 안 됨', videoPath: `videos/${randomUUID()}.mp4` })
    assert.equal(ghost.status, 400)
    assert.ok(ghost.json.fields.videoPath)
    assert.equal(ghost.text.includes(uploadDir), false, '내부 경로를 노출하지 않는다')

    const fake = `videos/${randomUUID()}.mp4`
    writeFileSync(join(uploadDir, fake), '영상이 아닌 글자')
    assert.ok((await patch(video.id, { videoPath: fake })).json.fields.videoPath)
    const wrongThumb = `thumbnails/${randomUUID()}.jpg`
    writeFileSync(join(uploadDir, wrongThumb), SAMPLES.png) // 내용은 PNG인데 .jpg 이름
    assert.ok((await patch(video.id, { thumbnailPath: wrongThumb })).json.fields.thumbnailPath)

    assert.deepEqual(await detail(video.id), before)
    assert.equal(exists(video.videoPath), true, '실패하면 옛 파일을 지우지 않는다')
    assert.equal(exists(thumbnailPath), true)
  })

  await t.test('다른 영상이 쓰는 파일로 바꾸려 하면 409이고, 자기 파일을 그대로 보내는 건 정상이다', async () => {
    const mine = await create()
    const other = await create({ thumbnailPath: await upload('thumbnail', SAMPLES.png) })

    const sameVideo = await patch(mine.id, { videoPath: other.videoPath })
    assert.equal(sameVideo.status, 409)
    assert.equal(sameVideo.json.code, 'FILE_ALREADY_USED')
    assert.ok(sameVideo.json.fields.videoPath)
    const sameThumbnail = await patch(mine.id, { thumbnailPath: other.thumbnailPath })
    assert.equal(sameThumbnail.status, 409)
    assert.ok(sameThumbnail.json.fields.thumbnailPath)

    assert.equal((await patch(mine.id, { videoPath: mine.videoPath, title: '내 파일 그대로' })).status, 200)
    assert.deepEqual(await detail(other.id), other, '다른 영상은 그대로')
    assert.equal(exists(other.videoPath), true)
  })

  await t.test('경로를 바꾸지 않으면 파일을 다시 검사하지 않는다(파일이 사라져도 제목은 고칠 수 있다)', async () => {
    const video = await create()
    unlinkSync(join(uploadDir, video.videoPath)) // 디스크에서 파일이 사라진 경우
    const res = await patch(video.id, { title: '파일이 없어도 고칠 수 있는 제목', videoPath: video.videoPath })
    assert.equal(res.status, 200)
    assert.equal(res.json.title, '파일이 없어도 고칠 수 있는 제목')
  })

  await t.test('여러 항목을 한 번에 바꿔도 하나의 요청으로 저장된다', async () => {
    const video = await create({ tagIds: [excel], quiz: QUIZ })
    const thumbnailPath = await upload('thumbnail', SAMPLES.jpg)
    const res = await patch(video.id, {
      title: '한꺼번에 바꾼 제목', description: '새 설명', tagIds: [auto, manner], thumbnailPath,
      quiz: { question: '새 질문', options: [{ content: '가', isCorrect: true }, { content: '나', isCorrect: false }] }
    })
    assert.equal(res.status, 200)
    assert.deepEqual([res.json.title, res.json.description, res.json.tagIds.length, res.json.thumbnailPath, res.json.quiz.question],
      ['한꺼번에 바꾼 제목', '새 설명', 2, thumbnailPath, '새 질문'])
  })

  await t.test('저장 도중 오류가 나면 모두 되돌리고, 옛 파일도 지우지 않는다', async () => {
    const video = await create({ tagIds: [excel], quiz: QUIZ })
    const before = await detail(video.id)
    const nextVideo = await upload('video', SAMPLES.webm)
    db.exec('ALTER TABLE quiz_options RENAME TO quiz_options_held') // 퀴즈 보기 저장 단계를 일부러 실패시킨다
    const original = console.error
    console.error = () => {}
    try {
      const res = await patch(video.id, {
        title: '되돌려질 제목', tagIds: [auto], videoPath: nextVideo,
        quiz: { question: '다른 질문', options: [{ content: '가', isCorrect: true }, { content: '나', isCorrect: false }] }
      })
      assert.equal(res.status, 500)
      assert.deepEqual(res.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
    } finally {
      console.error = original
      db.exec('ALTER TABLE quiz_options_held RENAME TO quiz_options')
    }
    assert.deepEqual(await detail(video.id), before, '제목·태그·퀴즈·파일 경로 모두 그대로')
    assert.equal(exists(video.videoPath), true, '저장이 실패했으니 옛 영상 파일을 지우지 않는다')
    assert.equal(exists(nextVideo), true)
    assert.equal((await patch(video.id, { videoPath: nextVideo })).status, 200, '되돌린 뒤 같은 파일로 다시 시도할 수 있다')
  })

  await t.test('두 영상이 같은 새 파일로 동시에 바꾸려 하면 하나만 성공한다', async () => {
    const first = await create()
    const second = await create()
    const shared = await upload('video', SAMPLES.mp4)
    const results = await Promise.all([patch(first.id, { videoPath: shared }), patch(second.id, { videoPath: shared })])
    assert.deepEqual(results.map(res => res.status).sort(), [200, 409])
  })

  await t.test('같은 영상을 동시에 여러 번 고쳐도 모두 성공하고 마지막 상태가 일관된다', async () => {
    const video = await create({ tagIds: [excel] })
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => patch(video.id, { title: `동시 수정 ${index}`, tagIds: [index % 2 === 0 ? auto : manner] })))
    assert.ok(results.every(res => res.status === 200))
    const final = await detail(video.id)
    assert.match(final.title, /^동시 수정 \d$/)
    assert.equal(final.tagIds.length, 1)
  })

  await t.test('옛 파일 정리는 안전하다: 규칙에 어긋난 경로, 링크, 이미 없는 파일, 다른 영상이 쓰는 파일은 건드리지 않는다', async () => {
    // (1) 저장된 경로가 규칙에 어긋난 비정상 데이터: 업로드 폴더 밖 파일을 지우면 안 된다
    const outside = join(uploadDir, '..', 'outside-file.txt')
    writeFileSync(outside, '지우면 안 되는 파일')
    const weird = await create()
    db.prepare('UPDATE videos SET video_path = ? WHERE id = ?').run('../outside-file.txt', weird.id)
    const weirdRes = await patch(weird.id, { videoPath: await upload('video', SAMPLES.mp4) })
    assert.equal(weirdRes.status, 200)
    assert.equal(existsSync(outside), true)

    // (2) 옛 경로가 링크인 경우: 링크도, 링크가 가리키는 파일도 지우지 않는다
    const target = await upload('video', SAMPLES.mp4)
    const linkPath = `videos/${randomUUID()}.mp4`
    symlinkSync(join(uploadDir, target), join(uploadDir, linkPath))
    const linked = await create()
    db.prepare('UPDATE videos SET video_path = ? WHERE id = ?').run(linkPath, linked.id)
    try {
      assert.equal((await patch(linked.id, { videoPath: await upload('video', SAMPLES.mp4) })).status, 200)
      assert.equal(exists(target), true)
      assert.equal(existsSync(join(uploadDir, linkPath)), true)
    } finally {
      unlinkSync(join(uploadDir, linkPath)) // 시험 도우미는 링크가 남아 있으면 임시 폴더 정리를 거절한다
    }

    // (3) 옛 파일이 이미 디스크에 없는 경우
    const missing = await create()
    unlinkSync(join(uploadDir, missing.videoPath))
    assert.equal((await patch(missing.id, { videoPath: await upload('video', SAMPLES.mp4) })).status, 200)

    // (4) 다른 영상이 같은 경로를 쓰고 있는 비정상 데이터: 지우지 않는다
    const owner = await create()
    db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)').run('같은 파일을 쓰는 영상', owner.videoPath)
    assert.equal((await patch(owner.id, { videoPath: await upload('video', SAMPLES.mp4) })).status, 200)
    assert.equal(exists(owner.videoPath), true)
  })

  await t.test('수정 요청은 다른 영상의 파일이나 행을 건드리지 않는다', async () => {
    const bystander = await create({ thumbnailPath: await upload('thumbnail', SAMPLES.png), tagIds: [excel], quiz: QUIZ })
    const target = await create()
    await patch(target.id, { title: '다른 영상을 고침', tagIds: [auto], quiz: QUIZ })
    assert.deepEqual(await detail(bystander.id), bystander)
    assert.equal(exists(bystander.videoPath), true)
    assert.equal(exists(bystander.thumbnailPath), true)
  })
})
