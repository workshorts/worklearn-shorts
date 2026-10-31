const TAG_FILTER = 'WHERE EXISTS (SELECT 1 FROM video_tags vt WHERE vt.video_id = videos.id AND vt.tag_id = ?)'

// Callers validate page/limit/tagId and own the snapshot shared with counts and DTO loading.
export function loadVideoPageIds(database, { page, limit, tagId = null }) {
  // Keep the exact SQLite int64 offset even when multiplication exceeds safe integers.
  const offset = (BigInt(page) - 1n) * BigInt(limit)
  const where = tagId === null ? '' : TAG_FILTER
  const filterParams = tagId === null ? [] : [tagId]
  return database.prepare(`SELECT id FROM videos ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...filterParams, limit, offset).map(row => row.id)
}

export function countVideos(database) {
  return database.prepare('SELECT COUNT(*) AS total FROM videos').get().total
}
