import { parseLimit, parsePage } from '../utils/pagination.js'
import { readOptionalVisitorId } from '../utils/visitor-id.js'

export function validateVideoListRequest(req, res, next) {
  const page = parsePage(req.query.page)
  const limit = parseLimit(req.query.limit)
  const visitorId = readOptionalVisitorId(req)
  // Publish the complete validated input only after every field succeeds.
  res.locals.videoListRequest = { page, limit, visitorId }
  next()
}
