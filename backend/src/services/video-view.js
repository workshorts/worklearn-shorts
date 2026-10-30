import { insertVideoView } from '../db/video-view-writes.js'
import { withVideoWriteTransaction } from './video-write.js'

// Callers validate the video ID and normalize the required visitor header first.
export function recordVideoView(database, { id, visitorId }) {
  return withVideoWriteTransaction(database, id, connection => {
    const { changes } = insertVideoView(connection, { videoId: id, visitorId })
    // A skipped duplicate can retain a nonzero lastInsertRowid; changes identifies this insert.
    return { videoId: id, counted: changes === 1 }
  })
}
