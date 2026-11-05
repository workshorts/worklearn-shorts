import { assertCommentVideoExists, countVideoComments, loadCommentPage } from '../db/comment-queries.js'
import { withTransaction } from '../db/transaction.js'
import { toCommentDto } from '../lib/comment-dto.js'

// Callers validate input; parent, total and page share one snapshot and return after commit.
export function loadCommentList(database, { id, page, limit }) {
  return withTransaction(database, connection => {
    assertCommentVideoExists(connection, id)
    const total = countVideoComments(connection, id)
    const data = loadCommentPage(connection, { videoId: id, page, limit }).map(toCommentDto)
    return { data, total }
  }, { mode: 'DEFERRED' })
}
