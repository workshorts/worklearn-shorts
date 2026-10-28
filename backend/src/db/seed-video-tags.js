import { normalizeTagName } from '../utils/tag-name.js'
import { validateSeedMediaPaths } from './seed-media.js'
import { SEED_VIDEOS } from './seed-videos.js'

const tagNamesByVideo = [
  ['엑셀', '업무자동화'], ['개발'], ['개발', '업무자동화'], ['비즈니스 매너'],
  [], ['기획/PM'], ['엑셀', '데이터 분석'], ['비즈니스 매너']
]

export const SEED_VIDEO_TAGS = Object.freeze(SEED_VIDEOS.flatMap(({ videoPath }, index) =>
  tagNamesByVideo[index].map(tagName => Object.freeze({ videoPath, tagName }))
))

// The caller owns the transaction and uses IMMEDIATE to protect lookup and insertion.
export function insertSeedVideoTags(database, links = SEED_VIDEO_TAGS) {
  if (!database.isOpen) {
    throw new Error('Database connection is closed.')
  }
  if (!database.isTransaction) {
    throw new Error('Seed video tag insertion requires an active transaction.')
  }
  if (!Array.isArray(links)) {
    throw new TypeError('Seed video tag insertion requires an array of links.')
  }

  const keysByPath = new Map()
  const candidates = []
  for (const link of links) {
    if (link === null || typeof link !== 'object' || Array.isArray(link)) {
      throw new TypeError('Seed video tag links must be objects.')
    }
    const { videoPath, tagName } = link
    if (typeof videoPath !== 'string' || typeof tagName !== 'string' ||
        tagName.trim().length < 1 || tagName.trim().length > 30 || tagName.includes('\0')) {
      throw new TypeError('Seed video tag links require a media path and a tag name of 1 to 30 characters without null characters.')
    }
    const tagKey = normalizeTagName(tagName)
    if (!keysByPath.has(videoPath)) keysByPath.set(videoPath, new Set())
    const keys = keysByPath.get(videoPath)
    if (!keys.has(tagKey)) {
      keys.add(tagKey)
      candidates.push({ videoPath, tagKey })
    }
  }
  if (candidates.length === 0) return []

  // Multiple tags may reference one video; validate each distinct media path once.
  const paths = [...keysByPath.keys()]
  validateSeedMediaPaths(paths.map(videoPath => ({ videoPath })))
  const findVideo = database.prepare('SELECT id FROM videos WHERE video_path = ? COLLATE BINARY LIMIT 2')
  const videoIds = new Map(paths.map(videoPath => {
    const rows = findVideo.all(videoPath)
    if (rows.length !== 1) {
      const error = new Error(rows.length === 0 ? 'A seed video tag link references a missing video.' : 'Multiple existing videos match a seed media path.')
      error.code = rows.length === 0 ? 'MISSING_SEED_VIDEO' : 'AMBIGUOUS_SEED_VIDEO'
      throw error
    }
    return [videoPath, rows[0].id]
  }))
  const findTag = database.prepare('SELECT id FROM tags WHERE normalize_tag_name(name) = ?')
  const tagIds = new Map([...new Set(candidates.map(({ tagKey }) => tagKey))].map(tagKey => {
    const row = findTag.get(tagKey)
    if (!row) {
      const error = new Error('A seed video tag link references a missing tag.')
      error.code = 'MISSING_SEED_TAG'
      throw error
    }
    return [tagKey, row.id]
  }))

  // Resolve every parent before writes; never create parents or remove other links.
  const pairs = candidates.map(({ videoPath, tagKey }) => ({ videoId: videoIds.get(videoPath), tagId: tagIds.get(tagKey) }))
  const insert = database.prepare(
    'INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?) ON CONFLICT (video_id, tag_id) DO NOTHING'
  )
  for (const { videoId, tagId } of pairs) insert.run(videoId, tagId)
  return pairs
}
