// Match SQLite character counts and reject text that cannot round-trip unchanged.
export function isCommentTextInRange(value, min, max) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) return false
  const length = Array.from(value).length
  return length >= min && length <= max
}
