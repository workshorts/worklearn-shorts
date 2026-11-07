import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SUMMARY_KEYS = ['id', 'name', 'description', 'videoCount', 'createdAt', 'updatedAt']
const DETAIL_KEYS = [...SUMMARY_KEYS, 'videos']
const VIDEO_KEYS = ['id', 'title', 'description', 'tags', 'videoUrl', 'thumbnailUrl', 'viewCount', 'likeCount',
  'likedByMe', 'commentCount', 'hasQuiz', 'createdAt', 'updatedAt', 'sortOrder']
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

test('관리자 학습과정 관리 API', { timeout: 90000 }, async t => {
  const { request, login, getDb } = await startAuthServer(t)
  const { cookie } = await login()
  const db = getDb()

  const call = (method, path, body, options = {}) => request(path, {
    method, body, cookie: options.cookie === undefined ? cookie : options.cookie, headers: options.headers
  })
  const addVideo = title => Number(db.prepare('INSERT INTO videos (title, description, video_path) VALUES (?, ?, ?)')
    .run(title, '', `videos/${randomUUID()}.mp4`).lastInsertRowid)
  const order = courseId => db.prepare('SELECT video_id, sort_order FROM course_videos WHERE course_id = ? ORDER BY sort_order').all(courseId).map(row => [row.video_id, row.sort_order])
  const count = table => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
  const create = async (body = {}) => {
    const res = await call('POST', '/api/admin/courses', { name: '엑셀 입문', videoIds: [v1], ...body })
    assert.equal(res.status, 201, res.text)
    return res.json
  }

  const [v1, v2, v3, v4] = ['단축키', '자동 채우기', '피벗 테이블', '매크로'].map(addVideo)

  await t.test('목록: 과정이 하나도 없으면 빈 목록이다', async () => {
    const empty = await call('GET', '/api/admin/courses')
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.json, { data: [], page: 1, limit: 20, total: 0 })
  })

  await t.test('로그인 없이는 다섯 API 모두 401이고, 쓰기 요청은 다른 Origin이면 403이다', async () => {
    for (const [method, path] of [['GET', '/api/admin/courses'], ['GET', '/api/admin/courses/1'], ['POST', '/api/admin/courses'], ['PUT', '/api/admin/courses/1'], ['DELETE', '/api/admin/courses/1']]) {
      const res = await call(method, path, method === 'POST' || method === 'PUT' ? { name: '이름입니다', videoIds: [v1] } : undefined, { cookie: '' })
      assert.equal(res.status, 401, `${method} ${path}`)
      assert.equal(res.json.code, 'AUTH_REQUIRED')
    }
    const course = await create()
    for (const [method, path, body] of [['POST', '/api/admin/courses', { name: '이름입니다', videoIds: [v1] }], ['PUT', `/api/admin/courses/${course.id}`, { name: '바꾼 이름', videoIds: [v1] }], ['DELETE', `/api/admin/courses/${course.id}`]]) {
      const res = await call(method, path, body, { headers: { Origin: 'http://evil.example' } })
      assert.equal(res.status, 403, `${method} ${path}`)
      assert.equal(res.json.code, 'ORIGIN_FORBIDDEN')
    }
    assert.equal((await call('GET', `/api/admin/courses/${course.id}`)).json.name, '엑셀 입문', '거절된 요청은 아무것도 바꾸지 않는다')
  })

  await t.test('JSON이 아니면 415, 잘못된 JSON이면 400 INVALID_JSON이다', async () => {
    assert.equal((await call('POST', '/api/admin/courses', 'x', { headers: { 'Content-Type': 'text/plain' } })).status, 415)
    assert.equal((await call('PUT', '/api/admin/courses/1', 'x', { headers: { 'Content-Type': 'text/plain' } })).status, 415)
    const broken = await call('POST', '/api/admin/courses', '{bad')
    assert.equal(broken.status, 400)
    assert.equal(broken.json.code, 'INVALID_JSON')
  })

  await t.test('목록: id 내림차순에 정해진 필드와 영상 수를 담는다', async () => {
    const before = (await call('GET', '/api/admin/courses')).json.total
    const first = await create({ name: '첫 과정', videoIds: [v1] })
    const second = await create({ name: '둘째 과정', videoIds: [v1, v2, v3] })
    const res = await call('GET', '/api/admin/courses')
    assert.equal(res.status, 200)
    assert.deepEqual(res.json.data.slice(0, 2).map(course => course.id), [second.id, first.id], '가장 새 과정이 맨 앞')
    assert.deepEqual(res.json.data.slice(0, 2).map(course => course.videoCount), [3, 1])
    assert.deepEqual(Object.keys(res.json.data[0]), SUMMARY_KEYS)
    assert.match(res.json.data[0].createdAt, ISO)
    assert.deepEqual([res.json.page, res.json.limit, res.json.total], [1, 20, before + 2])
    const ids = res.json.data.map(course => course.id)
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a), '전체가 id 내림차순')
  })

  await t.test('목록: page·limit으로 나눠 가져오고 잘못된 값은 400이다', async () => {
    const page2 = await call('GET', '/api/admin/courses?limit=1&page=2')
    assert.equal(page2.json.data.length, 1)
    assert.deepEqual([page2.json.page, page2.json.limit], [2, 1])
    assert.deepEqual((await call('GET', '/api/admin/courses?page=99')).json.data, [])
    for (const [query, field] of [['page=0', 'page'], ['page=abc', 'page'], ['page=1&page=2', 'page'], ['limit=0', 'limit'], ['limit=51', 'limit'], ['limit=', 'limit']]) {
      const res = await call('GET', `/api/admin/courses?${query}`)
      assert.equal(res.status, 400, query)
      assert.ok(res.json.fields[field], query)
    }
  })

  await t.test('생성: 201과 CourseDetail을 돌려주고, 배열 순서대로 sortOrder 1부터 저장한다', async () => {
    const res = await call('POST', '/api/admin/courses', { name: '  순서 확인 과정  ', description: '설명', videoIds: [v3, v1, v4] })
    assert.equal(res.status, 201)
    assert.deepEqual(Object.keys(res.json), DETAIL_KEYS)
    assert.equal(res.json.name, '순서 확인 과정', '앞뒤 공백은 지운다')
    assert.equal(res.json.description, '설명')
    assert.equal(res.json.videoCount, 3)
    assert.match(res.json.createdAt, ISO)
    assert.deepEqual(res.json.videos.map(video => [video.id, video.sortOrder]), [[v3, 1], [v1, 2], [v4, 3]])
    assert.deepEqual(Object.keys(res.json.videos[0]).sort(), [...VIDEO_KEYS].sort())
    assert.ok(res.json.videos.every(video => video.likedByMe === false), '관리자 응답의 likedByMe는 false')
    assert.equal(res.headers.location, `/api/admin/courses/${res.json.id}`)
    assert.deepEqual(order(res.json.id), [[v3, 1], [v1, 2], [v4, 3]])
    assert.deepEqual((await call('GET', `/api/admin/courses/${res.json.id}`)).json, res.json, '편집 정보 조회와 같다')
  })

  await t.test('생성: 설명을 생략하면 빈 문자열이고, 같은 영상이 여러 과정에 들어갈 수 있다', async () => {
    const a = await create({ name: '과정 A', videoIds: [v2] })
    const b = await create({ name: '과정 B', videoIds: [v2] })
    assert.equal(a.description, '')
    assert.deepEqual([a.videoCount, b.videoCount], [1, 1])
    assert.deepEqual([a.videos[0].id, b.videos[0].id], [v2, v2])
  })

  await t.test('생성: 글자 수는 유니코드 문자 단위로 센다(이모지 50개는 통과, 51개는 거절)', async () => {
    assert.equal((await call('POST', '/api/admin/courses', { name: '😀'.repeat(50), videoIds: [v1] })).status, 201)
    const tooLong = await call('POST', '/api/admin/courses', { name: '😀'.repeat(51), videoIds: [v1] })
    assert.equal(tooLong.status, 400)
    assert.ok(tooLong.json.fields.name)
  })

  await t.test('생성·수정 입력 오류는 400이고 아무것도 저장하지 않는다', async () => {
    const course = await create({ name: '수정 대상', videoIds: [v1, v2] })
    const before = [count('courses'), count('course_videos')]
    const cases = [
      ['이름 없음', { videoIds: [v1] }, 'name'],
      ['이름 숫자', { name: 5, videoIds: [v1] }, 'name'],
      ['이름 공백뿐', { name: '    ', videoIds: [v1] }, 'name'],
      ['이름 1자', { name: '가', videoIds: [v1] }, 'name'],
      ['이름 51자', { name: '가'.repeat(51), videoIds: [v1] }, 'name'],
      ['이름에 널 문자', { name: '이름\0이름', videoIds: [v1] }, 'name'],
      ['설명 301자', { name: '이름입니다', description: '가'.repeat(301), videoIds: [v1] }, 'description'],
      ['설명 null', { name: '이름입니다', description: null, videoIds: [v1] }, 'description'],
      ['설명 숫자', { name: '이름입니다', description: 7, videoIds: [v1] }, 'description'],
      ['영상 없음', { name: '이름입니다' }, 'videoIds'],
      ['영상 빈 배열', { name: '이름입니다', videoIds: [] }, 'videoIds'],
      ['영상 null', { name: '이름입니다', videoIds: null }, 'videoIds'],
      ['영상 문자열', { name: '이름입니다', videoIds: '1' }, 'videoIds'],
      ['영상 중복', { name: '이름입니다', videoIds: [v1, v1] }, 'videoIds'],
      ['영상 0', { name: '이름입니다', videoIds: [0] }, 'videoIds'],
      ['영상 음수', { name: '이름입니다', videoIds: [-1] }, 'videoIds'],
      ['영상 소수', { name: '이름입니다', videoIds: [1.5] }, 'videoIds'],
      ['영상 문자', { name: '이름입니다', videoIds: ['1'] }, 'videoIds'],
      ['영상 501개', { name: '이름입니다', videoIds: Array.from({ length: 501 }, (_, index) => index + 1) }, 'videoIds'],
      ['없는 영상', { name: '이름입니다', videoIds: [v1, 999999] }, 'videoIds'],
      ['알 수 없는 필드', { name: '이름입니다', videoIds: [v1], id: 9, videoCount: 5, videos: [] }, 'videos']
    ]
    for (const [label, body, field] of cases) {
      for (const [method, path] of [['POST', '/api/admin/courses'], ['PUT', `/api/admin/courses/${course.id}`]]) {
        const res = await call(method, path, body)
        assert.equal(res.status, 400, `${method} ${label}`)
        assert.equal(res.json.code, 'VALIDATION_ERROR', `${method} ${label}`)
        assert.ok(res.json.fields[field], `${method} ${label}: ${JSON.stringify(res.json.fields)}`)
      }
    }
    assert.match((await call('POST', '/api/admin/courses', { name: '이름입니다', videoIds: [v1, 999999, 888888] })).json.fields.videoIds, /999999, 888888/)
    assert.equal((await call('POST', '/api/admin/courses', [])).status, 400)
    assert.ok((await call('PUT', `/api/admin/courses/${course.id}`, [])).json.fields.body)
    assert.deepEqual([count('courses'), count('course_videos')], before)
    assert.deepEqual(order(course.id), [[v1, 1], [v2, 2]], '수정이 거절되면 기존 구성이 그대로다')
  })

  await t.test('상세: 없는 과정은 404, 잘못된 ID는 400이다', async () => {
    assert.equal((await call('GET', '/api/admin/courses/999999')).status, 404)
    assert.equal((await call('GET', '/api/admin/courses/999999')).json.code, 'NOT_FOUND')
    for (const id of ['abc', '0', '-1', '1.5', '9007199254740992', '1%3BDROP%20TABLE%20courses']) {
      const res = await call('GET', `/api/admin/courses/${id}`)
      assert.equal(res.status, 400, id)
      assert.ok(res.json.fields.id, id)
    }
  })

  await t.test('전체 수정: 이름·설명·영상 구성과 순서를 통째로 바꾸고 순서는 1부터 다시 매긴다', async () => {
    const course = await create({ name: '수정 전', description: '이전 설명', videoIds: [v1, v2, v3] })
    await pause(15)
    const swapped = await call('PUT', `/api/admin/courses/${course.id}`, { name: '  수정 후  ', description: '새 설명', videoIds: [v3, v2, v1] })
    assert.equal(swapped.status, 200)
    assert.deepEqual(Object.keys(swapped.json), DETAIL_KEYS)
    assert.equal(swapped.json.name, '수정 후')
    assert.equal(swapped.json.description, '새 설명')
    assert.deepEqual(swapped.json.videos.map(video => [video.id, video.sortOrder]), [[v3, 1], [v2, 2], [v1, 3]], '순서 맞바꿈도 문제없이 저장된다')
    assert.equal(swapped.json.createdAt, course.createdAt)
    assert.ok(swapped.json.updatedAt > course.updatedAt)

    const reshaped = await call('PUT', `/api/admin/courses/${course.id}`, { name: '수정 후', videoIds: [v4, v1] })
    assert.deepEqual(reshaped.json.videos.map(video => [video.id, video.sortOrder]), [[v4, 1], [v1, 2]], '영상을 빼고 새로 넣어도 1부터 이어진다')
    assert.equal(reshaped.json.description, '', '설명을 생략하면 빈 설명으로 바뀐다(전체 수정)')
    assert.deepEqual(order(course.id), [[v4, 1], [v1, 2]])
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM videos WHERE id IN (?, ?, ?)').get(v2, v3, v4).n, 3, '빠진 영상은 삭제되지 않는다')
  })

  await t.test('전체 수정: 값이 하나도 안 바뀌면 아무것도 저장하지 않고 updatedAt도 그대로이다(편집기는 모든 값을 보낸다)', async () => {
    const course = await create({ name: '그대로 과정', description: '설명', videoIds: [v1, v2] })
    await pause(15)
    const res = await call('PUT', `/api/admin/courses/${course.id}`, { name: course.name, description: course.description, videoIds: course.videos.map(video => video.id) })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, course)
  })

  await t.test('전체 수정: 없는 과정은 404이고, 입력 오류는 존재 여부보다 먼저 400이다', async () => {
    const missing = await call('PUT', '/api/admin/courses/999999', { name: '이름입니다', videoIds: [v1] })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.code, 'NOT_FOUND')
    assert.equal((await call('PUT', '/api/admin/courses/999999', { name: 'a', videoIds: [v1] })).status, 400)
    for (const id of ['abc', '0']) assert.equal((await call('PUT', `/api/admin/courses/${id}`, { name: '이름입니다', videoIds: [v1] })).status, 400, id)
  })

  await t.test('전체 수정: 도중 오류가 나면 이름·설명·영상 구성이 모두 원래대로 돌아간다', async () => {
    const course = await create({ name: '롤백 확인', description: '원래 설명', videoIds: [v1, v2] })
    const before = (await call('GET', `/api/admin/courses/${course.id}`)).json
    db.exec("CREATE TRIGGER block_link_insert BEFORE INSERT ON course_videos BEGIN SELECT RAISE(ABORT, '연결 저장 막음'); END")
    const original = console.error
    console.error = () => {}
    try {
      const res = await call('PUT', `/api/admin/courses/${course.id}`, { name: '되돌려질 이름', description: '되돌려질 설명', videoIds: [v3, v4] })
      assert.equal(res.status, 500)
      assert.deepEqual(res.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
    } finally {
      console.error = original
      db.exec('DROP TRIGGER block_link_insert')
    }
    assert.deepEqual((await call('GET', `/api/admin/courses/${course.id}`)).json, before, '지워졌던 연결까지 모두 복구된다')
    assert.equal((await call('PUT', `/api/admin/courses/${course.id}`, { name: '다시 시도', videoIds: [v3, v4] })).status, 200)
  })

  await t.test('삭제: 204와 빈 본문이고 과정과 연결만 사라지며 원본 영상은 남는다', async () => {
    const keep = await create({ name: '남길 과정', videoIds: [v1, v2] })
    const target = await create({ name: '지울 과정', videoIds: [v1, v2, v3] })
    const videosBefore = count('videos')
    const res = await call('DELETE', `/api/admin/courses/${target.id}`)
    assert.equal(res.status, 204)
    assert.equal(res.text, '')
    assert.equal((await call('GET', `/api/admin/courses/${target.id}`)).status, 404)
    assert.equal((await request(`/api/courses/${target.id}`)).status, 404, '사용자 화면에서도 사라진다')
    assert.deepEqual(order(target.id), [])
    assert.deepEqual(order(keep.id), [[v1, 1], [v2, 2]], '다른 과정의 구성은 그대로')
    assert.equal(count('videos'), videosBefore, '원본 영상은 모두 남는다')
    assert.equal((await call('DELETE', `/api/admin/courses/${target.id}`)).status, 404, '이미 지운 과정은 404')
    for (const id of ['abc', '0', '1.5']) assert.equal((await call('DELETE', `/api/admin/courses/${id}`)).status, 400, id)
  })

  await t.test('변경은 사용자 화면의 학습과정에 바로 반영된다', async () => {
    const course = await create({ name: '사용자 화면 확인', videoIds: [v1, v2] })
    await call('PUT', `/api/admin/courses/${course.id}`, { name: '이름이 바뀐 과정', videoIds: [v2, v3, v1] })
    const publicView = await request(`/api/courses/${course.id}`)
    assert.equal(publicView.json.name, '이름이 바뀐 과정')
    assert.deepEqual(publicView.json.videos.map(video => [video.id, video.sortOrder]), [[v2, 1], [v3, 2], [v1, 3]])
    const publicList = await request('/api/courses')
    assert.equal(publicList.json.data.find(item => item.id === course.id).videoCount, 3)
  })

  await t.test('같은 과정을 동시에 여러 번 수정해도 모두 성공하고 최종 순서가 1부터 빈틈없이 이어진다', async () => {
    const course = await create({ name: '동시 수정', videoIds: [v1, v2] })
    const sets = [[v1, v2, v3], [v3, v2], [v4, v1, v2, v3], [v2], [v3, v4, v1]]
    const results = await Promise.all(sets.map((videoIds, index) => call('PUT', `/api/admin/courses/${course.id}`, { name: `동시 ${index}번`, videoIds })))
    assert.ok(results.every(res => res.status === 200))
    const final = order(course.id)
    assert.deepEqual(final.map(([, sortOrder]) => sortOrder), final.map((_, index) => index + 1))
    assert.ok(sets.some(videoIds => JSON.stringify(videoIds) === JSON.stringify(final.map(([videoId]) => videoId))), '보낸 구성 중 하나가 통째로 남는다')
  })

  await t.test('동시에 만들면 서로 다른 과정이 생기고, 동시에 지우면 하나만 204이다', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => call('POST', '/api/admin/courses', { name: `동시 생성 ${index}`, videoIds: [v1] })))
    assert.ok(results.every(res => res.status === 201))
    assert.equal(new Set(results.map(res => res.json.id)).size, 5)
    const target = results[0].json.id
    const deletes = await Promise.all(Array.from({ length: 5 }, () => call('DELETE', `/api/admin/courses/${target}`)))
    assert.deepEqual(deletes.map(res => res.status).sort(), [204, 404, 404, 404, 404])
  })
})
