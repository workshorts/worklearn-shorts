const videoPathPattern = /^videos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:mp4|webm)$/i
const thumbnailPathPattern = /^thumbnails\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|jpeg|webp)$/i

function toStoredMediaUrl(value, pattern, message) {
  if (typeof value === 'string') {
    const match = pattern.exec(value)
    // Compare the whole match because a dollar anchor may accept a trailing newline.
    if (match?.[0] === value) {
      // Preserve stored case for files served from case-sensitive storage.
      return `/uploads/${value}`
    }
  }

  // A bad stored path is an internal data error, not a client validation failure.
  throw new Error(message)
}

export function toVideoUrl(value) {
  return toStoredMediaUrl(value, videoPathPattern, 'Invalid stored video path.')
}

export function toThumbnailUrl(value) {
  // Only an explicit database NULL means that no thumbnail was supplied.
  if (value === null) return '/images/default-thumbnail.svg'
  return toStoredMediaUrl(value, thumbnailPathPattern, 'Invalid stored thumbnail path.')
}
