import { getDb } from '../db/client.js'
import { errors } from '../errors.js'
import { parseCookies } from '../lib/cookies.js'
import { verifyAdminToken } from '../lib/token.js'

// 관리자 API 앞에 붙이는 로그인 확인: 쿠키의 서명·만료와 계정 존재를 확인한다
export function requireAdmin(req, res, next) {
  const token = parseCookies(req.headers.cookie).admin_session
  const payload = verifyAdminToken(token)
  if (!payload) return next(errors.authRequired())

  const admin = getDb().prepare('SELECT id, username FROM admins WHERE id = ?').get(payload.adminId)
  if (!admin) return next(errors.authRequired())

  req.admin = { id: admin.id, username: admin.username }
  next()
}
