import { errors } from '../errors.js'

// 요청 헤더의 Content-Type이 JSON이 아니면 415 (본문이 비어 있어도 헤더가 JSON이면 통과)
export function requireJson(req, res, next) {
  const type = String(req.headers['content-type'] || '').toLowerCase()
  if (!type.startsWith('application/json')) return next(errors.unsupportedMediaType())
  next()
}
