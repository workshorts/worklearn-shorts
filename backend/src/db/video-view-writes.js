// Callers supply validated IDs and normalized visitors inside the video write boundary.
export function insertVideoView(database, { videoId, visitorId }) {
  if (!database.isTransaction) {
    throw new Error('Video view insertion requires an active transaction.')
  }
  return database.prepare(`INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)
    ON CONFLICT (video_id, visitor_id) DO NOTHING`).run(videoId, visitorId)
}
