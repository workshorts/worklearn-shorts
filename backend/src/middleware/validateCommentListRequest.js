import { parseLimit, parsePage } from '../utils/pagination.js'
import { parseResourceId } from '../utils/resource-id.js'

export function validateCommentListRequest(req, res, next) {
  const id = parseResourceId(req.params.id)
  const page = parsePage(req.query.page)
  const limit = parseLimit(req.query.limit)
  // Publish complete input only after every check passes; public comments need no visitor ID.
  res.locals.commentListRequest = { id, page, limit }
  next()
}
