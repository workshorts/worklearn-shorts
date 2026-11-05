import { createCommentRequestLimiter } from '../lib/comment-request-limiter.js'

// Share process-local buckets across requests; creation and deletion remain independent.
const limiter = createCommentRequestLimiter()

export function limitCommentCreateRequest(req, res, next) {
  // Consume synchronously before hashing or storage; Express supplies the trusted IP.
  limiter.consumeCreate(req.ip)
  next()
}

export function limitCommentDeleteRequest(req, res, next) {
  // Consume before looking up the target or verifying its password, even if later work fails.
  limiter.consumeDelete(req.ip)
  next()
}
