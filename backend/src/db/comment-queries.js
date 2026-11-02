import { errors } from '../errors.js'

// Callers validate the ID and own the snapshot shared with later comment page queries.
export function assertCommentVideoExists(database, videoId) {
  const video = database.prepare('SELECT id FROM videos WHERE id = ?').get(videoId)
  if (video === undefined) throw errors.notFound('영상을 찾을 수 없습니다.')
}
