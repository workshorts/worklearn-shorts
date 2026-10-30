import { insertVideoLike } from '../db/video-like-writes.js'
import { withVideoWriteTransaction } from './video-write.js'

// Both fields come from like request validation; return only after the write commits.
export function addVideoLike(database, { id, visitorId }) {
  return withVideoWriteTransaction(database, id, connection =>
    insertVideoLike(connection, { videoId: id, visitorId }))
}
