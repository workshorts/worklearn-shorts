import { ApiError, errors } from '../errors.js'

const fileInUse = field =>
  new ApiError(409, 'FILE_ALREADY_USED', '이미 다른 영상에 연결된 파일입니다.', { [field]: '이미 다른 영상에 연결된 파일입니다.' })

// 영상 1개와 태그·퀴즈를 저장하고 새 영상 id를 돌려준다.
// 반드시 쓰기 트랜잭션(IMMEDIATE) 안에서 불러야 한다. 확인과 저장을 한 트랜잭션에 두어야
// 같은 파일을 동시에 등록하려는 두 요청 중 하나만 성공한다.
export function createVideo(database, { title, description, videoPath, thumbnailPath, tagIds, quiz }) {
  if (!database.isTransaction) throw new Error('Video creation requires an active transaction.')

  if (tagIds.length > 0) {
    const placeholders = tagIds.map(() => '?').join(', ')
    const known = new Set(database.prepare(`SELECT id FROM tags WHERE id IN (${placeholders})`).all(...tagIds).map(row => row.id))
    const missing = tagIds.filter(id => !known.has(id))
    if (missing.length > 0) throw errors.validation({ tagIds: `존재하지 않는 태그입니다: ${missing.join(', ')}` })
  }

  // 파일 경로의 대소문자만 다른 이름도 같은 파일로 본다.
  if (database.prepare('SELECT 1 FROM videos WHERE lower(video_path) = lower(?) LIMIT 1').get(videoPath)) throw fileInUse('videoPath')
  if (thumbnailPath !== null &&
      database.prepare('SELECT 1 FROM videos WHERE thumbnail_path IS NOT NULL AND lower(thumbnail_path) = lower(?) LIMIT 1').get(thumbnailPath)) {
    throw fileInUse('thumbnailPath')
  }

  const id = Number(database.prepare(
    'INSERT INTO videos (title, description, video_path, thumbnail_path) VALUES (?, ?, ?, ?)'
  ).run(title, description, videoPath, thumbnailPath).lastInsertRowid)

  const insertTag = database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
  for (const tagId of tagIds) insertTag.run(id, tagId)

  if (quiz !== null) {
    const quizId = Number(database.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)').run(id, quiz.question).lastInsertRowid)
    const insertOption = database.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
    // 배열 순서가 곧 보기 순서(sortOrder)다.
    quiz.options.forEach((option, index) => insertOption.run(quizId, option.content, index + 1, option.isCorrect ? 1 : 0))
  }

  return id
}
