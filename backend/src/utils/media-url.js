const videoPathPattern = /^videos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:mp4|webm)$/i

export function toVideoUrl(value) {
  if (typeof value === 'string') {
    const match = videoPathPattern.exec(value)
    // Compare the whole match because a dollar anchor may accept a trailing newline.
    if (match?.[0] === value) {
      // Preserve stored case for files served from case-sensitive storage.
      return `/uploads/${value}`
    }
  }

  // A bad stored path is an internal data error, not a client validation failure.
  throw new Error('Invalid stored video path.')
}
