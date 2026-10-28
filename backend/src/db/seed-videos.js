import { validateSeedMediaPaths } from './seed-media.js'

export const SEED_VIDEOS = Object.freeze([
  ['실무 엑셀 기초', 'mp4', 'png'],
  ['웹 개발 입문', 'webm', 'webp'],
  ['업무 자동화 입문', 'mp4', null],
  ['직장인 비즈니스 매너', 'mp4', 'jpg'],
  ['직장인을 위한 IT 기초', 'mp4', null],
  ['기획안 · 보고서 작성법', 'mp4', 'png'],
  ['데이터 분석 입문', 'webm', 'webp'],
  ['효율적인 커뮤니케이션', 'mp4', null]
].map(([title, extension, thumbnailExtension], index) => {
  const suffix = String(index + 1).padStart(12, '0')
  return Object.freeze({
    title,
    description: index === 4 ? '' : `${title}의 핵심을 짧게 배워보세요.`,
    videoPath: `videos/10000000-0000-4000-8000-${suffix}.${extension}`,
    thumbnailPath: thumbnailExtension === null ? null : `thumbnails/20000000-0000-4000-8000-${suffix}.${thumbnailExtension}`
  })
}))

// Media files must be verified before the caller's synchronous IMMEDIATE transaction.
export function insertSeedVideos(database, samples = SEED_VIDEOS) {
  if (!database.isOpen) {
    throw new Error('Database connection is closed.')
  }
  if (!database.isTransaction) {
    throw new Error('Seed video insertion requires an active transaction.')
  }

  const paths = validateSeedMediaPaths(samples)
  const candidates = Array.from(samples, (sample, index) => {
    const { title, description = '' } = sample
    if (typeof title !== 'string' || title.length < 2 || title.length > 100 || title.includes('\0')) {
      throw new TypeError('Seed video titles must contain 2 to 100 characters without null characters.')
    }
    if (typeof description !== 'string' || description.length > 500 || description.includes('\0')) {
      throw new TypeError('Seed video descriptions must contain at most 500 characters without null characters.')
    }
    return { title, description, ...paths[index] }
  })

  // Check every path before inserting anything; the schema intentionally permits duplicates.
  const find = database.prepare('SELECT id FROM videos WHERE video_path = ? COLLATE BINARY LIMIT 2')
  const existing = candidates.map(({ videoPath }) => {
    const rows = find.all(videoPath)
    if (rows.length > 1) {
      const error = new Error('Multiple existing videos match a seed media path.')
      error.code = 'AMBIGUOUS_SEED_VIDEO'
      throw error
    }
    return rows[0]
  })

  const insert = database.prepare(
    'INSERT INTO videos (title, description, video_path, thumbnail_path) VALUES (?, ?, ?, ?)'
  )
  return candidates.map(({ title, description, videoPath, thumbnailPath }, index) => {
    // Existing metadata, timestamps and related rows belong to the current owner.
    const id = existing[index]?.id ?? insert.run(title, description, videoPath, thumbnailPath).lastInsertRowid
    return { id, videoPath }
  })
}
