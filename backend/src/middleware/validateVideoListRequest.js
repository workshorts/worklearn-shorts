import { parseLimit, parsePage } from '../utils/pagination.js'
import { parseOptionalId } from '../utils/query-id.js'
import { readOptionalVisitorId } from '../utils/visitor-id.js'

export function validateVideoListRequest(req, res, next) {
  const page = parsePage(req.query.page)
  const limit = parseLimit(req.query.limit)
  const tagId = parseOptionalId(req.query.tagId, 'tagId')
  const visitorId = readOptionalVisitorId(req)
  // Publish the complete validated input only after every field succeeds.
  res.locals.videoListRequest = { page, limit, tagId, visitorId }
  next()
}
