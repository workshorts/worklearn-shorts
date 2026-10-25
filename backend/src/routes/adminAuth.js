import { Router } from 'express'
import { config } from '../config/index.js'
import { getDb } from '../db/client.js'
import { errors } from '../errors.js'
import { hashPassword, verifyPassword } from '../lib/password.js'
import { createLimiter } from '../lib/rateLimiter.js'
import { createAdminToken } from '../lib/token.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { requireJson } from '../middleware/requireJson.js'

export const adminAuthRouter = Router()

// 로그인 쿠키 공통 설정 (발급과 삭제에 같은 값을 써야 한다)
const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.cookieSecure,
  path: '/api/admin',
}

// 로그인 실패가 쌓이면 잠시 막는다 (기본: 15분 안에 5번)
const loginLimiter = createLimiter({
  windowMs: config.loginWindowMinutes * 60 * 1000,
  max: config.loginMaxFails,
})

// 없는 계정이어도 비밀번호 확인과 같은 시간이 걸리게 하려고 미리 만들어 둔 가짜 해시
const DUMMY_HASH = hashPassword('dummy-password-for-timing')

// POST /api/admin/login
adminAuthRouter.post('/login', requireJson, (req, res) => {
  const limitKey = req.ip
  const waitSeconds = loginLimiter.blockedSeconds(limitKey)
  if (waitSeconds > 0) throw errors.rateLimited(waitSeconds)

  const { username, password } = req.body ?? {}

  const fields = {}
  if (typeof username !== 'string' || username.length < 1 || username.length > 50) {
    fields.username = '1~50자로 입력하세요.'
  }
  if (typeof password !== 'string' || password.length < 1 || password.length > 128) {
    fields.password = '1~128자로 입력하세요.'
  }
  if (Object.keys(fields).length > 0) throw errors.validation(fields)

  const admin = getDb()
    .prepare('SELECT id, username, password_hash FROM admins WHERE username = ?')
    .get(username)

  const passwordOk = verifyPassword(password, admin ? admin.password_hash : DUMMY_HASH)
  if (!admin || !passwordOk) {
    loginLimiter.hit(limitKey)
    throw errors.invalidCredentials()
  }
  loginLimiter.reset(limitKey)

  res.cookie('admin_session', createAdminToken(admin.id), {
    ...cookieOptions,
    maxAge: config.sessionHours * 60 * 60 * 1000,
  })
  res.json({ id: admin.id, username: admin.username })
})

// POST /api/admin/logout - 쿠키가 없어도 성공
adminAuthRouter.post('/logout', (req, res) => {
  res.clearCookie('admin_session', cookieOptions)
  res.status(204).end()
})

// GET /api/admin/me - 로그인 상태 확인
adminAuthRouter.get('/me', requireAdmin, (req, res) => {
  res.json({ id: req.admin.id, username: req.admin.username })
})
