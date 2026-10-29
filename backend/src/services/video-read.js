import { withTransaction } from '../db/transaction.js'
import { loadVideos } from '../db/video-queries.js'
import { errors } from '../errors.js'

// Callers validate the resource ID and optional visitor header before invoking this service.
export function loadVideoDetail(database, { id, visitorId = null }) {
  const video = withTransaction(database, connection => loadVideos(connection, {
    where: 'WHERE v.id = ?',
    params: [id],
    visitorId,
  })[0], { mode: 'DEFERRED' })

  if (video === undefined) throw errors.notFound('영상을 찾을 수 없습니다.')
  return video
}
