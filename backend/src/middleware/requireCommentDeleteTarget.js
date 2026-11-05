import { getDb } from '../db/client.js'
import { loadCommentDeleteTarget } from '../db/comment-queries.js'

export function requireCommentDeleteTarget(req, res, next) {
  // Keep trusted DB credentials separate from request input for later password verification.
  const target = loadCommentDeleteTarget(getDb(), res.locals.commentDeleteRequest.id)
  res.locals.commentDeleteTarget = target
  next()
}
