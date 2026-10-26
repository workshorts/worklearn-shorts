import assert from 'node:assert/strict'
import test from 'node:test'
import { startAuthServer } from '../../backend/test/helpers/auth-server.js'
import { adminRequest, loginAdmin, getAdmin, logoutAdmin } from '../src/api/adminApi.js'

// 실제 서버와 임시 DB를 사용하며 Node에서 Origin·쿠키 전달만 모사한다.
// 브라우저 자체의 쿠키 정책 및 화면 검증을 대체하지 않는다.
test('FE 요청 함수와 실제 인증 서버 연동', async (t) => {
  const { admin, request } = await startAuthServer(t)
  const original = globalThis.fetch
  let cookie = ''
  let origin = 'http://localhost:5173'
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (path, options) => {
    assert.equal(options.credentials, 'include')
    const res = await request(path, {
      method: options.method, body: options.body,
      headers: { ...options.headers, Origin: origin }, cookie,
    })
    const setCookie = res.headers['set-cookie']?.[0]
    if (setCookie) cookie = setCookie.split(';')[0]
    return new Response(res.status === 204 ? null : res.text, { status: res.status, headers: res.headers })
  }
  await t.test('미인증과 계정 불일치를 구분', async () => {
    await assert.rejects(getAdmin(), (e) => e.code === 'AUTH_REQUIRED' && /만료/.test(e.message))
    await assert.rejects(loginAdmin(admin.username, 'wrong'), (e) => e.code === 'INVALID_CREDENTIALS')
  })
  await t.test('서버 필드 검증 결과 전달', async () => {
    await assert.rejects(loginAdmin('a'.repeat(51), 'p'.repeat(129)), (e) => e.code === 'VALIDATION_ERROR' && !!e.fields.username && !!e.fields.password)
  })
  await t.test('로그인 후 세션 확인 및 로그아웃', async () => {
    assert.equal((await loginAdmin(admin.username, admin.password)).username, admin.username)
    assert.equal((await getAdmin()).username, admin.username)
    assert.equal(await logoutAdmin(), null)
    await assert.rejects(getAdmin(), (e) => e.code === 'AUTH_REQUIRED')
  })
  await t.test('Origin 거절을 주소 오류로 안내', async () => {
    origin = 'http://invalid.example'
    await assert.rejects(loginAdmin(admin.username, admin.password), (e) => e.code === 'ORIGIN_FORBIDDEN' && /접속 주소/.test(e.message))
  })
  await t.test('업로드에 JSON Content-Type을 강제하지 않음', async () => {
    globalThis.fetch = async (_path, options) => {
      assert.equal(options.headers['Content-Type'], undefined)
      assert.ok(options.body instanceof FormData)
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
    }
    await adminRequest('uploads', { method: 'POST', body: new FormData() })
  })
  await t.test('HTML fallback을 인증 성공으로 처리하지 않음', async () => {
    globalThis.fetch = async () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } })
    await assert.rejects(getAdmin(), (e) => e.status === 502)
  })
})
