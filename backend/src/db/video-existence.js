import { errors } from '../errors.js'

// Callers validate the ID and own the connection and snapshot for subsequent reads.
export function assertVideoExists(database, videoId) {
  const video = database.prepare('SELECT id FROM videos WHERE id = ?').get(videoId)
  if (video === undefined) throw errors.notFound('영상을 찾을 수 없습니다.')
}
