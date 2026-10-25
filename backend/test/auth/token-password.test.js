import assert from 'node:assert/strict'
import test from 'node:test'

process.env.AUTH_SECRET = 'test-secret-test-secret-1234'
process.env.ADMIN_SESSION_HOURS = '8'

const { createAdminToken, verifyAdminToken } = await import('../../src/lib/token.js')
const { hashPassword, verifyPassword } = await import('../../src/lib/password.js')
const { parseCookies } = await import('../../src/lib/cookies.js')
const { createLimiter } = await import('../../src/lib/rateLimiter.js')

test('토큰: 만들면 검증되고, 서명이나 내용을 바꾸면 거절된다', () => {
  const token = createAdminToken(7)
  const verified = verifyAdminToken(token)
  assert.equal(verified.adminId, 7)
  assert.ok(verified.exp > Math.floor(Date.now() / 1000))

  const [payload, signature] = token.split('.')
  assert.equal(verifyAdminToken(payload + '.' + signature.slice(0, -2) + 'AA'), null)
  const forged = Buffer.from(JSON.stringify({ sub: 1, exp: 9999999999 })).toString('base64url')
  assert.equal(verifyAdminToken(forged + '.' + signature), null)
  assert.equal(verifyAdminToken('abc'), null)
  assert.equal(verifyAdminToken(undefined), null)
})

test('비밀번호: 같은 비밀번호도 해시가 매번 다르고, 맞는 값만 통과한다', () => {
  const first = hashPassword('Test1234!')
  const second = hashPassword('Test1234!')
  assert.notEqual(first, second)
  assert.match(first, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/)
  assert.equal(verifyPassword('Test1234!', first), true)
  assert.equal(verifyPassword('wrong', first), false)
  assert.equal(verifyPassword('Test1234!', 'not-a-hash'), false)
})

test('쿠키: 헤더 문자열을 이름과 값으로 나눈다', () => {
  const cookies = parseCookies('a=1; admin_session=abc.def; b=%ED%95%9C')
  assert.equal(cookies.a, '1')
  assert.equal(cookies.admin_session, 'abc.def')
  assert.equal(cookies.b, '한')
  assert.deepEqual(Object.keys(parseCookies(undefined)), [])
  assert.equal(parseCookies('__proto__=x').__proto__, 'x')
  assert.equal({}.polluted, undefined)
})

test('제한기: 횟수가 차면 막고, reset하면 풀린다', () => {
  const limiter = createLimiter({ windowMs: 60000, max: 2 })
  assert.equal(limiter.blockedSeconds('k'), 0)
  limiter.hit('k')
  assert.equal(limiter.blockedSeconds('k'), 0)
  limiter.hit('k')
  assert.ok(limiter.blockedSeconds('k') > 0)
  assert.equal(limiter.blockedSeconds('other'), 0)
  limiter.reset('k')
  assert.equal(limiter.blockedSeconds('k'), 0)
})
