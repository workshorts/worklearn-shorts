import { withTransaction } from '../db/transaction.js'
import { loadVideos } from '../db/video-queries.js'
import { countVideos, loadVideoPageIds } from '../db/video-page-queries.js'
import { errors } from '../errors.js'

// Callers validate pagination, the optional tag ID and visitor header before invoking this service.
export function loadVideoList(database, { page, limit, tagId = null, visitorId = null }) {
  return withTransaction(database, connection => {
    const total = countVideos(connection, { tagId })
    const ids = loadVideoPageIds(connection, { page, limit, tagId })
    const data = ids.length === 0 ? [] : loadVideos(connection, {
      where: `WHERE v.id IN (${ids.map(() => '?').join(', ')})`,
      params: ids,
      orderBy: 'v.id DESC',
      visitorId,
    })
    return { data, total }
  }, { mode: 'DEFERRED' })
}

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
