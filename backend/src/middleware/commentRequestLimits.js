import { createCommentRequestLimiter } from '../lib/comment-request-limiter.js'

// Share process-local buckets across requests; deletion will use its separate bucket.
const limiter = createCommentRequestLimiter()

export function limitCommentCreateRequest(req, res, next) {
  // Consume synchronously before hashing or storage; Express supplies the trusted IP.
  limiter.consumeCreate(req.ip)
  next()
}
