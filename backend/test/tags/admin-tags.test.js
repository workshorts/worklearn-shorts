import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'

test('관리자 태그 관리 API', { timeout: 60000 }, async t => {
  const { request, login, getDb } = await startAuthServer(t)
  const { cookie } = await login()
  const db = getDb()

  const call = (method, path, body, options = {}) => request(path, {
    method, body, cookie: options.cookie === undefined ? cookie : options.cookie, headers: options.headers
  })
  const create = (name, options) => call('POST', '/api/admin/tags', { name }, options)
  const addVideo = title => Number(db.prepare('INSERT INTO videos (title, description, video_path) VALUES (?, ?, ?)')
    .run(title, '', `videos/${randomUUID()}.mp4`).lastInsertRowid)
  const names = async () => (await request('/api/tags')).json.data.map(tag => tag.name)
  const count = table => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count

  await t.test('로그인 없이 401, 다른 Origin 403, JSON이 아니면 415, 잘못된 JSON이면 400이다', async () => {
    assert.equal((await create('엑셀', { cookie: '' })).status, 401)
    assert.equal((await call('DELETE', '/api/admin/tags/1', undefined, { cookie: '' })).status, 401)
    const evil = await create('엑셀', { headers: { Origin: 'http://evil.example' } })
    assert.equal(evil.status, 403)
    assert.equal(evil.json.code, 'ORIGIN_FORBIDDEN')
    assert.equal((await call('DELETE', '/api/admin/tags/1', undefined, { headers: { Origin: 'http://evil.example' } })).status, 403)
    assert.equal((await call('POST', '/api/admin/tags', 'x', { headers: { 'Content-Type': 'text/plain' } })).status, 415)
    const broken = await call('POST', '/api/admin/tags', '{bad')
    assert.equal(broken.status, 400)
    assert.equal(broken.json.code, 'INVALID_JSON')
    assert.equal(count('tags'), 0, '거절된 요청은 태그를 만들지 않는다')
  })

  await t.test('생성: 201과 { id, name }을 돌려주고, 앞뒤 공백은 지우되 대소문자는 그대로 저장하며 공개 태그 목록에 보인다', async () => {
    const res = await create('  Excel 활용  ')
    assert.equal(res.status, 201)
    assert.deepEqual(Object.keys(res.json), ['id', 'name'])
    assert.equal(res.json.name, 'Excel 활용')
    assert.equal(db.prepare('SELECT name FROM tags WHERE id = ?').get(res.json.id).name, 'Excel 활용')
    assert.ok((await names()).includes('Excel 활용'))
    const second = await create('업무자동화')
    assert.equal(second.status, 201)
    assert.ok(second.json.id > res.json.id)
  })

  await t.test('생성: 이름 안의 공백·기호는 그대로 저장하고, 위험해 보이는 문자열도 글자 그대로 저장된다', async () => {
    const odd = await create("  가  나 ; DROP TABLE tags; --  ")
    assert.equal(odd.status, 201)
    assert.equal(odd.json.name, '가  나 ; DROP TABLE tags; --')
    assert.ok(count('tags') >= 3, 'tags 테이블이 그대로다')
    assert.equal((await create('😀'.repeat(30))).status, 201, '이모지 30개(30자)는 통과')
  })

  await t.test('중복: 같은 이름, 대소문자만 다른 이름, 앞뒤 공백만 다른 이름은 409 TAG_ALREADY_EXISTS이다', async () => {
    assert.equal((await create('엑셀')).status, 201)
    const before = count('tags')
    for (const duplicate of ['엑셀', '  엑셀  ', 'EXCEL 활용', 'excel 활용', ' eXcEl 활용 ']) {
      const res = await create(duplicate)
      assert.equal(res.status, 409, duplicate)
      assert.equal(res.json.code, 'TAG_ALREADY_EXISTS', duplicate)
      assert.ok(res.json.fields.name, duplicate)
    }
    assert.equal((await create('ÉCOLE')).status, 201)
    assert.equal((await create('école')).status, 409, '악센트 있는 글자의 대소문자도 같은 이름으로 본다')
    assert.equal(count('tags'), before + 1, '거절된 요청은 태그를 만들지 않는다')
  })

  await t.test('입력 오류는 400이다: 빈 이름, 공백뿐, 길이, 형식, 알 수 없는 필드', async () => {
    const before = count('tags')
    const cases = [
      ['이름 없음', {}, 'name'],
      ['이름 null', { name: null }, 'name'],
      ['이름 숫자', { name: 5 }, 'name'],
      ['이름 배열', { name: ['엑셀'] }, 'name'],
      ['이름 빈 문자열', { name: '' }, 'name'],
      ['이름 공백뿐', { name: '     ' }, 'name'],
      ['이름 31자', { name: '가'.repeat(31) }, 'name'],
      ['이모지 31개', { name: '😀'.repeat(31) }, 'name'],
      ['이름에 널 문자', { name: '이름\0이름' }, 'name'],
      ['알 수 없는 필드', { name: '정상 이름', id: 5, slug: 'x' }, 'slug']
    ]
    for (const [label, body, field] of cases) {
      const res = await call('POST', '/api/admin/tags', body)
      assert.equal(res.status, 400, label)
      assert.equal(res.json.code, 'VALIDATION_ERROR', label)
      assert.ok(res.json.fields[field], `${label}: ${JSON.stringify(res.json.fields)}`)
    }
    const array = await call('POST', '/api/admin/tags', [])
    assert.equal(array.status, 400)
    assert.ok(array.json.fields.body)
    assert.equal(count('tags'), before)
  })

  await t.test('동시에 같은 이름을 만들면 하나만 201이고, 서로 다른 이름은 모두 만들어진다', async () => {
    const same = await Promise.all(Array.from({ length: 6 }, () => create('동시 생성 태그')))
    assert.deepEqual(same.map(res => res.status).sort(), [201, 409, 409, 409, 409, 409])
    const different = await Promise.all(Array.from({ length: 5 }, (_, index) => create(`동시 태그 ${index}`)))
    assert.ok(different.every(res => res.status === 201))
    assert.equal(new Set(different.map(res => res.json.id)).size, 5)
  })

  await t.test('삭제: 204와 빈 본문이고, 태그 연결만 사라지며 영상과 다른 태그는 그대로이다', async () => {
    const keepTag = (await create('남길 태그')).json
    const dropTag = (await create('지울 태그')).json
    const [a, b] = [addVideo('영상 A'), addVideo('영상 B')]
    const link = db.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
    link.run(a, keepTag.id); link.run(a, dropTag.id); link.run(b, dropTag.id)
    const videosBefore = count('videos')

    const res = await call('DELETE', `/api/admin/tags/${dropTag.id}`)
    assert.equal(res.status, 204)
    assert.equal(res.text, '')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM video_tags WHERE tag_id = ?').get(dropTag.id).n, 0, '모든 영상에서 연결이 사라진다')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM video_tags WHERE tag_id = ?').get(keepTag.id).n, 1, '다른 태그의 연결은 그대로')
    assert.equal(count('videos'), videosBefore, '영상은 모두 남는다')
    assert.equal((await names()).includes('지울 태그'), false, '공개 태그 목록에서도 사라진다')

    const detail = await call('GET', `/api/admin/videos/${a}`)
    assert.deepEqual(detail.json.tagIds, [keepTag.id])
    assert.deepEqual(detail.json.tags.map(tag => tag.name), ['남길 태그'])
    assert.deepEqual((await call('GET', `/api/admin/videos/${b}`)).json.tags, [])
  })

  await t.test('삭제: 없는 태그는 404이고 이미 지운 태그를 다시 지워도 404, 잘못된 ID는 400이다', async () => {
    const tag = (await create('한 번만 지우는 태그')).json
    assert.equal((await call('DELETE', `/api/admin/tags/${tag.id}`)).status, 204)
    const again = await call('DELETE', `/api/admin/tags/${tag.id}`)
    assert.equal(again.status, 404)
    assert.equal(again.json.code, 'NOT_FOUND')
    assert.equal((await call('DELETE', '/api/admin/tags/999999')).status, 404)
    for (const id of ['abc', '0', '-1', '1.5', '9007199254740992', '1%3BDROP%20TABLE%20tags']) {
      const res = await call('DELETE', `/api/admin/tags/${id}`)
      assert.equal(res.status, 400, id)
      assert.ok(res.json.fields.id, id)
    }
  })

  await t.test('지운 태그의 이름은 다시 만들 수 있다', async () => {
    const tag = (await create('재사용 태그')).json
    assert.equal((await create('재사용 태그')).status, 409)
    await call('DELETE', `/api/admin/tags/${tag.id}`)
    const again = await create('재사용 태그')
    assert.equal(again.status, 201)
    assert.notEqual(again.json.id, tag.id, '새 번호가 붙는다')
  })

  await t.test('삭제 도중 오류가 나면 태그와 영상 연결이 모두 그대로 남는다', async () => {
    const tag = (await create('롤백 확인 태그')).json
    const video = addVideo('롤백 확인 영상')
    db.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(video, tag.id)
    db.exec("CREATE TRIGGER block_tag_delete BEFORE DELETE ON tags BEGIN SELECT RAISE(ABORT, '삭제 막음'); END")
    const original = console.error
    console.error = () => {}
    try {
      const res = await call('DELETE', `/api/admin/tags/${tag.id}`)
      assert.equal(res.status, 500)
      assert.deepEqual(res.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
    } finally {
      console.error = original
      db.exec('DROP TRIGGER block_tag_delete')
    }
    assert.ok((await names()).includes('롤백 확인 태그'))
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM video_tags WHERE tag_id = ?').get(tag.id).n, 1)
    assert.equal((await call('DELETE', `/api/admin/tags/${tag.id}`)).status, 204, '문제를 없앤 뒤 다시 삭제하면 성공')
  })

  await t.test('같은 태그를 동시에 지우면 하나만 204이다', async () => {
    const tag = (await create('동시 삭제 태그')).json
    const results = await Promise.all(Array.from({ length: 6 }, () => call('DELETE', `/api/admin/tags/${tag.id}`)))
    assert.deepEqual(results.map(res => res.status).sort(), [204, 404, 404, 404, 404, 404])
  })
})
