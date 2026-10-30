// Callers supply validated IDs and normalized visitors inside the video write boundary.
export function insertVideoLike(database, { videoId, visitorId }) {
  if (!database.isTransaction) {
    throw new Error('Video like insertion requires an active transaction.')
  }
  return database.prepare(`INSERT INTO video_likes (video_id, visitor_id) VALUES (?, ?)
    ON CONFLICT (video_id, visitor_id) DO NOTHING`).run(videoId, visitorId)
}
