import { errors } from '../errors.js'
import { verifyPassword } from '../lib/password.js'

export function verifyCommentDeletePassword(req, res, next) {
  const { password } = res.locals.commentDeleteRequest
  const { id, password_hash: passwordHash } = res.locals.commentDeleteTarget
  if (!verifyPassword(password, passwordHash)) throw errors.commentPasswordMismatch()

  // Only successful verification publishes the exact internal credentials for conditional deletion.
  res.locals.verifiedCommentDeleteTarget = { id, passwordHash }
  next()
}
