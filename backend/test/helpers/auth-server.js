import http from 'node:http'
import { createDatabaseContext } from './database-context.js'

// 임시 DB와 서버를 만들어 관리자 API를 실제 HTTP로 시험한다.
// 설정은 코드를 가져오기 전에 환경변수로 정해야 하므로, 시험 파일마다 한 번만 호출한다.
export async function startAuthServer(t, options = {}) {
  const context = createDatabaseContext(t)
  const databasePath = context.path('auth.db')
  context.initialize(databasePath)

  process.env.DB_PATH = databasePath
  process.env.AUTH_SECRET = 'test-secret-test-secret-1234'
  process.env.ALLOWED_ORIGIN = 'http://localhost:5173'
  process.env.ADMIN_SESSION_HOURS = String(options.sessionHours ?? 8)
  process.env.LOGIN_MAX_FAILS = String(options.loginMaxFails ?? 100)
  process.env.LOGIN_WINDOW_MINUTES = String(options.loginWindowMinutes ?? 15)

  const { hashPassword } = await import('../../src/lib/password.js')
  const { app } = await import('../../src/app.js')
  const { closeDb, getDb } = await import('../../src/db/client.js')

  // Close shared connections before removing the workspace, even if setup fails.
  context.addCleanup(closeDb)

  const admin = { username: 'admin', password: 'Test1234!' }
  getDb()
    .prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
    .run(admin.username, hashPassword(admin.password))

  const server = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started))
  })
  const port = server.address().port

  context.addCleanup(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  // fetch는 Origin 같은 헤더를 마음대로 못 바꾸므로 node:http를 쓴다
  function request(path, { method = 'GET', body, headers = {}, cookie } = {}) {
    return new Promise((resolve, reject) => {
      const sendHeaders = { ...headers }
      let payload
      if (body !== undefined) {
        payload = typeof body === 'string' ? body : JSON.stringify(body)
        sendHeaders['Content-Type'] ??= 'application/json'
        sendHeaders['Content-Length'] = Buffer.byteLength(payload)
      }
      if (cookie) sendHeaders.Cookie = cookie

      const req = http.request(
        { host: '127.0.0.1', port, path, method, headers: sendHeaders },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let json = null
            try {
              json = JSON.parse(text)
            } catch {
              json = null
            }
            resolve({ status: res.statusCode, headers: res.headers, text, json })
          })
        },
      )
      req.on('error', reject)
      if (payload !== undefined) req.write(payload)
      req.end()
    })
  }

  async function login(password = admin.password) {
    const res = await request('/api/admin/login', {
      method: 'POST',
      body: { username: admin.username, password },
    })
    const setCookie = res.headers['set-cookie']?.[0] ?? ''
    return { res, cookie: setCookie.split(';')[0] }
  }

  return { admin, request, login, getDb }
}
