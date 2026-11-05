import { insertComment } from '../db/comment-writes.js'
import { toCommentDto } from '../lib/comment-dto.js'
import { withVideoWriteTransaction } from './video-write.js'

// Hashing is already complete; recheck the parent and return public data only after commit.
export function createComment(database, candidate) {
  return withVideoWriteTransaction(database, candidate.id, connection =>
    toCommentDto(insertComment(connection, candidate)))
}
