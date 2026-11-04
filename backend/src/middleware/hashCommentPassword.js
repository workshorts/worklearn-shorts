import { hashPassword } from '../lib/password.js'

export function hashCommentPassword(req, res, next) {
  // Validation, quota and parent checks must finish before this synchronous hash.
  const { id, nickname, password, content } = res.locals.commentCreateRequest
  const passwordHash = hashPassword(password)

  // Forward only storage fields; the original password is not part of this candidate.
  res.locals.commentCreateRequest = { id, nickname, passwordHash, content }
  next()
}
