import assert from 'node:assert/strict'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'

test('로그인 시도 제한', { timeout: 30000 }, async (t) => {
  // 3번 실패하면 막고, 약 1.2초 뒤에 풀리게 해서 시험한다
  const { admin, request, login } = await startAuthServer(t, { loginMaxFails: 3, loginWindowMinutes: 0.02 })
  const wrong = () => request('/api/admin/login', { method: 'POST', body: { username: admin.username, password: 'wrong' } })

  await t.test('성공하면 실패 횟수가 0으로 돌아간다', async () => {
    assert.equal((await wrong()).status, 401)
    assert.equal((await wrong()).status, 401)
    assert.equal((await login()).res.status, 200)
    assert.equal((await wrong()).status, 401)
    assert.equal((await wrong()).status, 401)
    assert.equal((await login()).res.status, 200)
  })

  await t.test('입력 형식 오류(400)는 실패로 세지 않는다', async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await request('/api/admin/login', { method: 'POST', body: { username: '' } })
      assert.equal(res.status, 400)
    }
    assert.equal((await login()).res.status, 200)
  })

  await t.test('실패가 쌓이면 429와 Retry-After로 막고, 시간이 지나면 풀린다', async () => {
    assert.equal((await wrong()).status, 401)
    assert.equal((await wrong()).status, 401)
    assert.equal((await wrong()).status, 401)

    const blocked = await wrong()
    assert.equal(blocked.status, 429)
    assert.equal(blocked.json.code, 'RATE_LIMITED')
    assert.ok(Number(blocked.headers['retry-after']) >= 1)

    // 막힌 동안은 올바른 비밀번호도 받지 않는다
    assert.equal((await login()).res.status, 429)

    await new Promise((resolve) => setTimeout(resolve, 1400))
    assert.equal((await login()).res.status, 200)
  })
})
