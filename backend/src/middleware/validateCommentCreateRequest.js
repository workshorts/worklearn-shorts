import { errors } from '../errors.js'
import { parseResourceId } from '../utils/resource-id.js'

function isTextInRange(value, min, max) {
  // Match SQLite character counts and reject text that cannot round-trip unchanged.
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) return false
  const length = Array.from(value).length
  return length >= min && length <= max
}

export function validateCommentCreateRequest(req, res, next) {
  const id = parseResourceId(req.params.id)
  const body = req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body : {}
  const nickname = Object.hasOwn(body, 'nickname') ? body.nickname : undefined
  const password = Object.hasOwn(body, 'password') ? body.password : undefined
  const content = Object.hasOwn(body, 'content') ? body.content : undefined
  const fields = {}
  if (!isTextInRange(nickname, 1, 20)) fields.nickname = '닉네임은 1~20자로 입력하세요.'
  if (!isTextInRange(password, 4, 30)) fields.password = '비밀번호는 4~30자로 입력하세요.'
  if (!isTextInRange(content, 1, 500)) fields.content = '내용은 1~500자로 입력하세요.'
  if (Object.keys(fields).length > 0) throw errors.validation(fields)

  // Preserve exact input, including password whitespace; forward only declared fields.
  res.locals.commentCreateRequest = { id, nickname, password, content }
  next()
}
