import { errors } from '../errors.js'
import { isSupportedPasswordHash } from '../lib/password.js'
import { loadCommentDeleteTarget } from './comment-queries.js'

// Callers validate fields and recheck the parent inside withVideoWriteTransaction.
export function insertComment(database, candidate) {
  if (!database.isOpen) throw new Error('Database connection is closed.')
  if (!database.isTransaction) throw new Error('Comment insertion requires an active transaction.')
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('Comment insertion requires a prepared password hash.')
  }

  const { id, nickname, passwordHash, content } = candidate
  if (!isSupportedPasswordHash(passwordHash)) {
    throw new TypeError('Comment insertion requires a prepared password hash.')
  }
  // Let SQLite assign identity and time; neither credentials nor hashes leave this query.
  return database.prepare(`INSERT INTO comments (video_id, nickname, password_hash, content)
    VALUES (?, ?, ?, ?) RETURNING id, video_id, nickname, content, created_at`)
    .get(id, nickname, passwordHash, content)
}

// Callers supply the trusted verification snapshot inside an IMMEDIATE transaction.
export function deleteVerifiedComment(database, candidate) {
  if (!database.isOpen) throw new Error('Database connection is closed.')
  if (!database.isTransaction) throw new Error('Comment deletion requires an active transaction.')
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('Comment deletion requires a verified ID and password hash.')
  }
  const { id, passwordHash } = candidate
  if (!Number.isSafeInteger(id) || id < 1 || !isSupportedPasswordHash(passwordHash)) {
    throw new TypeError('Comment deletion requires a verified ID and password hash.')
  }

  // Bind the exact verified credentials so a changed or replaced target cannot be deleted.
  const { changes } = database.prepare('DELETE FROM comments WHERE id = ? AND password_hash = ?').run(id, passwordHash)
  if (changes === 1) return

  // A missing row is 404; changed credentials require fresh verification rather than deletion.
  const current = loadCommentDeleteTarget(database, id)
  if (current.password_hash !== passwordHash) throw errors.commentPasswordMismatch()
  throw new Error('Verified comment deletion did not remove its target.')
}
