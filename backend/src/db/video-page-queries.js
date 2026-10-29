// Callers validate page/limit and own the snapshot shared with counts and DTO loading.
export function loadVideoPageIds(database, { page, limit }) {
  // Keep the exact SQLite int64 offset even when multiplication exceeds safe integers.
  const offset = (BigInt(page) - 1n) * BigInt(limit)
  return database.prepare('SELECT id FROM videos ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(limit, offset).map(row => row.id)
}
