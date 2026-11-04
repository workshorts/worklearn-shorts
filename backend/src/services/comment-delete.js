import { deleteVerifiedComment } from '../db/comment-writes.js'
import { withTransaction } from '../db/transaction.js'

// Verification is already complete; conditional deletion must commit before HTTP success.
export function deleteComment(database, verifiedTarget) {
  return withTransaction(database, connection => deleteVerifiedComment(connection, verifiedTarget), { mode: 'IMMEDIATE' })
}
