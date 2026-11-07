import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { hashPassword } from '../../src/lib/password.js'
import { startAuthServer } from '../helpers/auth-server.js'

test('관리자 댓글 삭제 API', { timeout: 60000 }, async t => {
  const { request, login, getDb } = await startAuthServer(t)
  const { cookie } = await login()
  const db = getDb()

  const del = (id, options = {}) => request(`/api/admin/comments/${id}`, {
    method: 'DELETE', body: options.body, cookie: options.cookie === undefined ? cookie : options.cookie, headers: options.headers
  })
  const addVideo = title => Number(db.prepare('INSERT INTO videos (title, description, video_path) VALUES (?, ?, ?)')
    .run(title, '', `videos/${randomUUID()}.mp4`).lastInsertRowid)
  // 사용자 삭제 흐름(비밀번호 확인)도 쓸 수 있게 진짜 해시로 넣는다.
  const addComment = (videoId, nickname, content, password = 'pw1234') => Number(db.prepare(
    'INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)'
  ).run(videoId, nickname, hashPassword(password), content).lastInsertRowid)
  const listOf = async videoId => (await request(`/api/videos/${videoId}/comments`)).json
  const exists = id => db.prepare('SELECT 1 FROM comments WHERE id = ?').get(id) !== undefined

  const video = addVideo('댓글이 달린 영상')
  const otherVideo = addVideo('다른 영상')

  await t.test('로그인 없이는 401이고(잘못된 ID여도 401이 먼저), 다른 Origin은 403이며 댓글은 그대로이다', async () => {
    const comment = addComment(video, '작성자', '지우면 안 되는 댓글')
    for (const id of [comment, 'abc', 999999]) {
      const res = await del(id, { cookie: '' })
      assert.equal(res.status, 401, String(id))
      assert.equal(res.json.code, 'AUTH_REQUIRED')
    }
    const evil = await del(comment, { headers: { Origin: 'http://evil.example' } })
    assert.equal(evil.status, 403)
    assert.equal(evil.json.code, 'ORIGIN_FORBIDDEN')
    assert.equal(exists(comment), true)
  })

  await t.test('잘못된 ID는 400, 없는 댓글은 404이다', async () => {
    for (const id of ['abc', '0', '-1', '1.5', '9007199254740992', '1%3BDROP%20TABLE%20comments']) {
      const res = await del(id)
      assert.equal(res.status, 400, id)
      assert.equal(res.json.code, 'VALIDATION_ERROR', id)
      assert.ok(res.json.fields.id, id)
    }
    const missing = await del(999999)
    assert.equal(missing.status, 404)
    assert.equal(missing.json.code, 'NOT_FOUND')
  })

  await t.test('삭제하면 204와 빈 본문이고, 비밀번호 없이 지워지며 사용자 화면의 댓글 목록과 수에서도 빠진다', async () => {
    const target = addComment(video, '지울 작성자', '관리자가 지울 댓글')
    const keep = addComment(video, '남길 작성자', '남아야 하는 댓글')
    const before = await listOf(video)
    assert.ok(before.data.some(comment => comment.id === target))

    const res = await del(target)
    assert.equal(res.status, 204)
    assert.equal(res.text, '')
    assert.equal(exists(target), false)

    const after = await listOf(video)
    assert.equal(after.total, before.total - 1)
    assert.equal(after.data.some(comment => comment.id === target), false)
    assert.equal(after.data.some(comment => comment.id === keep), true)
    const detail = await request(`/api/admin/videos/${video}`, { cookie })
    assert.equal(detail.json.commentCount, after.total, '영상의 댓글 수도 줄어든다')
  })

  await t.test('요청에 비밀번호가 없거나 틀린 값이 있어도 상관없이 지워진다(관리자 권한이 기준)', async () => {
    const noBody = addComment(video, '작성자 1', '본문 없이 삭제')
    assert.equal((await del(noBody)).status, 204)
    const wrongPassword = addComment(video, '작성자 2', '틀린 비밀번호가 와도 삭제')
    assert.equal((await del(wrongPassword, { body: { password: 'wrong-password' } })).status, 204)
    assert.equal(exists(noBody) || exists(wrongPassword), false)
  })

  await t.test('영상과 다른 영상의 댓글은 건드리지 않는다', async () => {
    const target = addComment(video, '작성자', '지울 댓글')
    const bystander = addComment(otherVideo, '다른 영상 작성자', '다른 영상의 댓글')
    const videosBefore = db.prepare('SELECT COUNT(*) AS n FROM videos').get().n
    await del(target)
    assert.equal(exists(bystander), true)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM videos').get().n, videosBefore, '영상은 그대로다')
    assert.equal((await listOf(otherVideo)).data.some(comment => comment.id === bystander), true)
  })

  await t.test('이미 지운 댓글을 다시 지우면 404이다', async () => {
    const comment = addComment(video, '작성자', '두 번 지우는 댓글')
    assert.equal((await del(comment)).status, 204)
    const again = await del(comment)
    assert.equal(again.status, 404)
    assert.equal(again.json.code, 'NOT_FOUND')
  })

  await t.test('관리자 삭제는 사용자 삭제의 시도 제한을 받지 않고, 사용자 삭제(비밀번호)와도 서로 영향이 없다', async () => {
    const ids = Array.from({ length: 30 }, (_, index) => addComment(video, `작성자 ${index}`, `대량 삭제 ${index}`))
    const results = []
    for (const id of ids) results.push((await del(id)).status)
    assert.ok(results.every(status => status === 204), '30번 연속 삭제해도 429가 없다')

    // 사용자 삭제는 그대로 비밀번호로 동작한다.
    const mine = addComment(video, '직접 삭제할 작성자', '작성자가 직접 지우는 댓글', 'my-password')
    const userDelete = await request(`/api/comments/${mine}`, { method: 'DELETE', body: { password: 'my-password' } })
    assert.equal(userDelete.status, 204)
    assert.equal(exists(mine), false)
    const protectedComment = addComment(video, '보호된 작성자', '비밀번호가 틀리면 지워지지 않는 댓글', 'right-password')
    const wrong = await request(`/api/comments/${protectedComment}`, { method: 'DELETE', body: { password: 'wrong-password' } })
    assert.notEqual(wrong.status, 204)
    assert.equal(exists(protectedComment), true, '관리자 API가 사용자 삭제의 비밀번호 확인을 느슨하게 만들지 않는다')
  })

  await t.test('삭제 도중 오류가 나면 댓글이 그대로 남는다', async () => {
    const comment = addComment(video, '작성자', '롤백 확인 댓글')
    db.exec("CREATE TRIGGER block_comment_delete BEFORE DELETE ON comments BEGIN SELECT RAISE(ABORT, '삭제 막음'); END")
    const original = console.error
    console.error = () => {}
    try {
      const res = await del(comment)
      assert.equal(res.status, 500)
      assert.deepEqual(res.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
    } finally {
      console.error = original
      db.exec('DROP TRIGGER block_comment_delete')
    }
    assert.equal(exists(comment), true)
    assert.equal((await del(comment)).status, 204, '문제를 없앤 뒤 다시 삭제하면 성공')
  })

  await t.test('같은 댓글을 동시에 지우면 하나만 204이다', async () => {
    const comment = addComment(video, '작성자', '동시 삭제 댓글')
    const results = await Promise.all(Array.from({ length: 6 }, () => del(comment)))
    assert.deepEqual(results.map(res => res.status).sort(), [204, 404, 404, 404, 404, 404])
  })

  await t.test('영상을 지우면 그 영상의 댓글도 함께 사라져서 관리자 삭제 대상이 없다(404)', async () => {
    const doomed = addVideo('곧 지울 영상')
    const comment = addComment(doomed, '작성자', '영상과 함께 사라질 댓글')
    assert.equal((await request(`/api/admin/videos/${doomed}`, { method: 'DELETE', cookie })).status, 204)
    assert.equal((await del(comment)).status, 404)
  })
})
