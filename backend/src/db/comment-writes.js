import { isSupportedPasswordHash } from '../lib/password.js'

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
