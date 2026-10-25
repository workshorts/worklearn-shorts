import { config } from '../config/index.js'
import { errors } from '../errors.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// 관리자 변경 요청(POST·PUT·PATCH·DELETE)의 Origin을 확인한다.
// 브라우저는 Origin을 자동으로 붙인다. 헤더가 아예 없는 요청(curl, Postman)은 통과시킨다.
export function requireAllowedOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next()

  const origin = req.headers.origin
  if (origin === undefined) return next()
  if (!config.allowedOrigins.includes(origin)) return next(errors.originForbidden())
  next()
}
