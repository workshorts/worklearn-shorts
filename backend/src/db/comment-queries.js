import { errors } from '../errors.js'

// Preserve the existing comment-specific name while sharing the parent lookup with quizzes.
export { assertVideoExists as assertCommentVideoExists } from './video-existence.js'

// Return only public columns; callers own input validation and the shared read snapshot.
export function loadCommentPage(database, { videoId, page, limit }) {
  const offset = (BigInt(page) - 1n) * BigInt(limit)
  return database.prepare(`SELECT id, video_id, nickname, content, created_at FROM comments
    WHERE video_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(videoId, limit, offset)
}

// Count the same video's full collection independently of the requested page.
export function countVideoComments(database, videoId) {
  return database.prepare('SELECT COUNT(*) AS count FROM comments WHERE video_id = ?').get(videoId).count
}

// Internal credentials only: never serialize this target as a public comment.
// Callers validate the ID and own the connection and transaction scope.
export function loadCommentDeleteTarget(database, id) {
  const target = database.prepare('SELECT id, password_hash FROM comments WHERE id = ?').get(id)
  if (target === undefined) throw errors.notFound('댓글을 찾을 수 없습니다.')
  return target
}
