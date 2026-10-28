import { normalizeTagName } from '../utils/tag-name.js'

export const SEED_TAG_NAMES = Object.freeze([
  '엑셀', '개발', '업무자동화', '비즈니스 매너', '기획/PM', '데이터 분석', '준비 중'
])

// The caller owns the transaction and uses IMMEDIATE to serialize seed writes.
export function insertSeedTags(database, names = SEED_TAG_NAMES) {
  if (!database.isOpen) {
    throw new Error('Database connection is closed.')
  }
  if (!database.isTransaction) {
    throw new Error('Seed tag insertion requires an active transaction.')
  }
  if (!Array.isArray(names)) {
    throw new TypeError('Seed tag insertion requires an array of tag names.')
  }

  // Validate the entire batch before writes, keeping the first display spelling.
  const candidates = new Map()
  for (const value of names) {
    if (typeof value !== 'string') {
      throw new TypeError('Seed tag names must be strings.')
    }
    const name = value.trim()
    if (name.length < 1 || name.length > 30 || name.includes('\0')) {
      throw new TypeError('Seed tag names must contain 1 to 30 characters without null characters.')
    }
    const key = normalizeTagName(name)
    if (!candidates.has(key)) candidates.set(key, name)
  }

  const find = database.prepare('SELECT id, name FROM tags WHERE normalize_tag_name(name) = ?')
  const insert = database.prepare('INSERT INTO tags (name) VALUES (?)')
  const tags = []
  for (const [key, name] of candidates) {
    const existing = find.get(key)
    if (existing) {
      // Avoid INSERT OR IGNORE so a skipped tag does not advance the sequence.
      tags.push({ id: existing.id, name: existing.name })
    } else {
      const { lastInsertRowid } = insert.run(name)
      tags.push({ id: lastInsertRowid, name })
    }
  }
  return tags
}
