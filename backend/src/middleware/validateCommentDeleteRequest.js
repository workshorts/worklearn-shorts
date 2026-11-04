import { errors } from '../errors.js'
import { isCommentTextInRange } from '../utils/comment-text.js'
import { parseResourceId } from '../utils/resource-id.js'

export function validateCommentDeleteRequest(req, res, next) {
  const id = parseResourceId(req.params.id)
  const body = req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body : {}
  const password = Object.hasOwn(body, 'password') ? body.password : undefined
  if (!isCommentTextInRange(password, 4, 30)) {
    throw errors.validation({ password: '비밀번호는 4~30자로 입력하세요.' })
  }

  // Preserve the exact password for later verification and publish only complete input.
  res.locals.commentDeleteRequest = { id, password }
  next()
}
