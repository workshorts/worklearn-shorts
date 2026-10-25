export function normalizeTagName(name) {
  if (typeof name !== 'string') {
    throw new TypeError('Tag names must be strings.')
  }

  // Preserve display names; use this value only for normalized comparisons.
  return name.trim().toLowerCase()
}
