import { assertSynchronousTransactionCallback, withTransaction } from '../db/transaction.js'
import { errors } from '../errors.js'

// Callers validate the ID; the operation keeps the same write lock through commit.
export function withVideoWriteTransaction(database, id, operation) {
  // Validate the original operation before wrapping it so async callbacks cannot bypass the guard.
  assertSynchronousTransactionCallback(operation)
  return withTransaction(database, connection => {
    const video = connection.prepare('SELECT id FROM videos WHERE id = ?').get(id)
    if (video === undefined) throw errors.notFound('영상을 찾을 수 없습니다.')
    return operation(connection)
  }, { mode: 'IMMEDIATE' })
}
