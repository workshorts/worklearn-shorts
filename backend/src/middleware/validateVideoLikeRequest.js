import { parseResourceId } from '../utils/resource-id.js'
import { readRequiredVisitorId } from '../utils/visitor-id.js'

export function validateVideoLikeRequest(req, res, next) {
  const id = parseResourceId(req.params.id)
  const visitorId = readRequiredVisitorId(req)
  // Both like methods consume the same complete input before any database work.
  res.locals.videoLikeRequest = { id, visitorId }
  next()
}
