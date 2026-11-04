import { getDb } from '../db/client.js'
import { assertCommentVideoExists } from '../db/comment-queries.js'

export function requireCommentVideo(req, res, next) {
  // Reject missing parents before hashing; storage must recheck inside withVideoWriteTransaction.
  assertCommentVideoExists(getDb(), res.locals.commentCreateRequest.id)
  next()
}
