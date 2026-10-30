export function countVideoViews(database, videoId) {
  return database.prepare('SELECT COUNT(*) AS count FROM video_views WHERE video_id = ?').get(videoId).count
}
