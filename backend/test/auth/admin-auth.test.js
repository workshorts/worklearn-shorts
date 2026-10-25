import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'

test('관리자 로그인·세션·Origin 검증', { timeout: 30000 }, async (t) => {
  const { admin, request, login, getDb } = await startAuthServer(t)

  await t.test('로그인에 성공하면 보호된 쿠키를 준다', async () => {
    const { res } = await login()
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { id: 1, username: 'admin' })
    const cookie = res.headers['set-cookie'][0]
    assert.match(cookie, /^admin_session=/)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Lax/)
    assert.match(cookie, /Path=\/api\/admin/)
    assert.match(cookie, /Max-Age=28800/)
  })

  await t.test('비밀번호가 틀려도 없는 계정이어도 같은 401로 답한다', async () => {
    const wrong = await request('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } })
    const unknown = await request('/api/admin/login', { method: 'POST', body: { username: 'nobody', password: 'wrong' } })
    assert.equal(wrong.status, 401)
    assert.equal(wrong.json.code, 'INVALID_CREDENTIALS')
    assert.deepEqual(unknown.json, wrong.json)
  })

  await t.test('입력 형식 오류는 400, JSON이 아니면 415', async () => {
    const missing = await request('/api/admin/login', { method: 'POST', body: { username: '' } })
    assert.equal(missing.status, 400)
    assert.equal(missing.json.code, 'VALIDATION_ERROR')
    assert.ok(missing.json.fields.username)
    assert.ok(missing.json.fields.password)

    const broken = await request('/api/admin/login', { method: 'POST', body: '{bad' })
    assert.equal(broken.status, 400)
    assert.equal(broken.json.code, 'INVALID_JSON')

    const text = await request('/api/admin/login', { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } })
    assert.equal(text.status, 415)
    assert.equal(text.json.code, 'UNSUPPORTED_MEDIA_TYPE')

    const empty = await request('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    assert.equal(empty.status, 400)
  })

  await t.test('me는 로그인한 관리자에게만 답한다', async () => {
    const anonymous = await request('/api/admin/me')
    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.json.code, 'AUTH_REQUIRED')

    const { cookie } = await login()
    const me = await request('/api/admin/me', { cookie })
    assert.equal(me.status, 200)
    assert.deepEqual(me.json, { id: 1, username: 'admin' })

    const tampered = await request('/api/admin/me', { cookie: cookie.slice(0, -3) + 'abc' })
    assert.equal(tampered.status, 401)
  })

  await t.test('만료된 토큰과 삭제된 계정의 토큰은 거절한다', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: 1, exp: 1 })).toString('base64url')
    const signature = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest().toString('base64url')
    const expired = await request('/api/admin/me', { cookie: 'admin_session=' + payload + '.' + signature })
    assert.equal(expired.status, 401)

    getDb().prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run('temp-admin', 'x')
    const tempId = getDb().prepare('SELECT id FROM admins WHERE username = ?').get('temp-admin').id
    const future = Math.floor(Date.now() / 1000) + 3600
    const tempPayload = Buffer.from(JSON.stringify({ sub: tempId, exp: future })).toString('base64url')
    const tempSignature = createHmac('sha256', process.env.AUTH_SECRET).update(tempPayload).digest().toString('base64url')
    const tempCookie = 'admin_session=' + tempPayload + '.' + tempSignature
    assert.equal((await request('/api/admin/me', { cookie: tempCookie })).status, 200)
    getDb().prepare('DELETE FROM admins WHERE id = ?').run(tempId)
    assert.equal((await request('/api/admin/me', { cookie: tempCookie })).status, 401)
  })

  await t.test('로그아웃은 쿠키가 없어도 204이고 쿠키를 지운다', async () => {
    const res = await request('/api/admin/logout', { method: 'POST' })
    assert.equal(res.status, 204)
    assert.match(res.headers['set-cookie'][0], /Expires=Thu, 01 Jan 1970/)
  })

  await t.test('허용되지 않은 Origin의 변경 요청은 403', async () => {
    const body = { username: admin.username, password: admin.password }
    const evil = await request('/api/admin/login', { method: 'POST', body, headers: { Origin: 'http://evil.example' } })
    assert.equal(evil.status, 403)
    assert.equal(evil.json.code, 'ORIGIN_FORBIDDEN')

    const nullOrigin = await request('/api/admin/login', { method: 'POST', body, headers: { Origin: 'null' } })
    assert.equal(nullOrigin.status, 403)

    const logoutEvil = await request('/api/admin/logout', { method: 'POST', headers: { Origin: 'http://evil.example' } })
    assert.equal(logoutEvil.status, 403)

    const allowed = await request('/api/admin/login', { method: 'POST', body, headers: { Origin: 'http://localhost:5173' } })
    assert.equal(allowed.status, 200)

    const noOrigin = await request('/api/admin/login', { method: 'POST', body })
    assert.equal(noOrigin.status, 200)

    // GET은 검사하지 않는다 (로그인하지 않았으니 401)
    const safe = await request('/api/admin/me', { headers: { Origin: 'http://evil.example' } })
    assert.equal(safe.status, 401)
  })

  await t.test('없는 주소는 같은 오류 형식의 404', async () => {
    const res = await request('/api/admin/nothing')
    assert.equal(res.status, 404)
    assert.deepEqual(Object.keys(res.json).sort(), ['code', 'fields', 'message'])
  })
})
