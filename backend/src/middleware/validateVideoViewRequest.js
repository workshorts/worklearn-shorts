import { parseResourceId } from '../utils/resource-id.js'
import { readRequiredVisitorId } from '../utils/visitor-id.js'

export function validateVideoViewRequest(req, res, next) {
  const id = parseResourceId(req.params.id)
  const visitorId = readRequiredVisitorId(req)
  // Publish complete input only after both checks pass and before any database work.
  res.locals.videoViewRequest = { id, visitorId }
  next()
}
