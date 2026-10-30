// Callers supply validated IDs and normalized visitors inside the video write boundary.
export function insertVideoLike(database, { videoId, visitorId }) {
  if (!database.isTransaction) {
    throw new Error('Video like insertion requires an active transaction.')
  }
  return database.prepare(`INSERT INTO video_likes (video_id, visitor_id) VALUES (?, ?)
    ON CONFLICT (video_id, visitor_id) DO NOTHING`).run(videoId, visitorId)
}

export function deleteVideoLike(database, { videoId, visitorId }) {
  if (!database.isTransaction) {
    throw new Error('Video like deletion requires an active transaction.')
  }
  return database.prepare('DELETE FROM video_likes WHERE video_id = ? AND visitor_id = ?').run(videoId, visitorId)
}
