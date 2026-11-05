import { isIP } from 'node:net'
import { readCommentLimitConfig } from '../config/comment-limits.js'
import { errors } from '../errors.js'
import { createLimiter } from './rateLimiter.js'

// Create once per application and share across requests; state belongs to this process.
export function createCommentRequestLimiter(environment = process.env) {
  const config = readCommentLimitConfig(environment)
  const create = createLimiter(config.create)
  const remove = createLimiter(config.delete)

  function consume(limiter, ip) {
    // Callers supply Express req.ip, never a forwarded header or a resource-specific key.
    if (typeof ip !== 'string' || isIP(ip) === 0) {
      throw new TypeError('Comment request limiting requires a valid client IP.')
    }
    // Keep the check and hit synchronous so the next attempt sees the consumed quota.
    const seconds = limiter.blockedSeconds(ip)
    if (seconds > 0) throw errors.rateLimited(seconds)
    limiter.hit(ip)
  }

  return Object.freeze({
    consumeCreate: ip => consume(create, ip),
    consumeDelete: ip => consume(remove, ip),
  })
}
