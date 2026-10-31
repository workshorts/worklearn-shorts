export function countVideoLikes(database, videoId) {
  return database.prepare('SELECT COUNT(*) AS count FROM video_likes WHERE video_id = ?').get(videoId).count
}
