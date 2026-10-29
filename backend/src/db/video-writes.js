import { ApiError, errors } from '../errors.js'
import { loadQuiz } from './quiz-queries.js'

const fileInUse = field =>
  new ApiError(409, 'FILE_ALREADY_USED', '이미 다른 영상에 연결된 파일입니다.', { [field]: '이미 다른 영상에 연결된 파일입니다.' })

// 태그가 모두 실제로 있는지 확인한다.
function assertTagsExist(database, tagIds) {
  if (tagIds.length === 0) return
  const placeholders = tagIds.map(() => '?').join(', ')
  const known = new Set(database.prepare(`SELECT id FROM tags WHERE id IN (${placeholders})`).all(...tagIds).map(row => row.id))
  const missing = tagIds.filter(id => !known.has(id))
  if (missing.length > 0) throw errors.validation({ tagIds: `존재하지 않는 태그입니다: ${missing.join(', ')}` })
}

// 파일을 다른 영상이 이미 쓰고 있으면 409다. exceptId는 자기 자신(수정할 영상)을 빼기 위한 값이다.
// 파일 경로의 대소문자만 다른 이름도 같은 파일로 본다.
function assertFilesFree(database, { videoPath = null, thumbnailPath = null }, exceptId = null) {
  if (videoPath !== null &&
      database.prepare('SELECT 1 FROM videos WHERE id IS NOT ? AND lower(video_path) = lower(?) LIMIT 1').get(exceptId, videoPath)) {
    throw fileInUse('videoPath')
  }
  if (thumbnailPath !== null &&
      database.prepare('SELECT 1 FROM videos WHERE id IS NOT ? AND thumbnail_path IS NOT NULL AND lower(thumbnail_path) = lower(?) LIMIT 1').get(exceptId, thumbnailPath)) {
    throw fileInUse('thumbnailPath')
  }
}

function insertQuiz(database, videoId, quiz) {
  const quizId = Number(database.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)').run(videoId, quiz.question).lastInsertRowid)
  const insertOption = database.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
  // 배열 순서가 곧 보기 순서(sortOrder)다.
  quiz.options.forEach((option, index) => insertOption.run(quizId, option.content, index + 1, option.isCorrect ? 1 : 0))
}

function insertTags(database, videoId, tagIds) {
  const insertTag = database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
  for (const tagId of tagIds) insertTag.run(videoId, tagId)
}

// 영상 1개와 태그·퀴즈를 저장하고 새 영상 id를 돌려준다.
// 반드시 쓰기 트랜잭션(IMMEDIATE) 안에서 불러야 한다. 확인과 저장을 한 트랜잭션에 두어야
// 같은 파일을 동시에 등록하려는 두 요청 중 하나만 성공한다.
export function createVideo(database, { title, description, videoPath, thumbnailPath, tagIds, quiz }) {
  if (!database.isTransaction) throw new Error('Video creation requires an active transaction.')

  assertTagsExist(database, tagIds)
  assertFilesFree(database, { videoPath, thumbnailPath })

  const id = Number(database.prepare(
    'INSERT INTO videos (title, description, video_path, thumbnail_path) VALUES (?, ?, ?, ?)'
  ).run(title, description, videoPath, thumbnailPath).lastInsertRowid)

  insertTags(database, id, tagIds)
  if (quiz !== null) insertQuiz(database, id, quiz)
  return id
}

// 영상의 현재 파일 경로만 읽는다(저장된 경로가 규칙에 어긋나도 읽을 수 있게 URL 변환 없이). 없으면 null.
export function readVideoFilePaths(database, id) {
  const row = database.prepare('SELECT video_path, thumbnail_path FROM videos WHERE id = ?').get(id)
  return row ? { videoPath: row.video_path, thumbnailPath: row.thumbnail_path } : null
}

// 이 수정 요청에서 '바뀌는' 새 파일만 골라낸다. 그대로인 경로는 다시 검사하지 않는다
// (제목만 고칠 때 큰 영상 파일을 매번 읽지 않도록). thumbnailPath: null은 새 파일이 아니다.
export function changedFiles(changes, current) {
  return {
    videoPath: changes.videoPath !== undefined && changes.videoPath !== current.videoPath ? changes.videoPath : null,
    thumbnailPath: changes.thumbnailPath !== undefined && changes.thumbnailPath !== null && changes.thumbnailPath !== current.thumbnailPath
      ? changes.thumbnailPath : null
  }
}

const sameQuiz = (existing, input) =>
  existing.question === input.question && existing.options.length === input.options.length &&
  existing.options.every((option, index) => option.content === input.options[index].content && option.isCorrect === input.options[index].isCorrect)

// 영상 수정을 적용한다. 반드시 쓰기 트랜잭션(IMMEDIATE) 안에서 부른다.
// changes에는 보낸 항목만 들어 있다(생략=유지). 실제로 값이 바뀐 항목만 저장하고, 아무것도 바뀌지 않으면 updatedAt도 그대로 둔다.
// verified는 호출한 쪽이 트랜잭션 밖에서 미리 검사해 둔 새 파일 경로의 집합이다.
//
// 결과: { status: 'missing' } 영상이 없음 / { status: 'retry' } 검사한 뒤 그 사이 파일이 바뀌어 다시 검사해야 함 /
//       { status: 'ok', replacedPaths } 저장 완료. replacedPaths는 교체되어 더 이상 쓰이지 않는 옛 파일 경로다.
export function applyVideoPatch(database, id, changes, verified) {
  if (!database.isTransaction) throw new Error('Video update requires an active transaction.')

  const current = database.prepare('SELECT id, title, description, video_path, thumbnail_path FROM videos WHERE id = ?').get(id)
  if (!current) return { status: 'missing' }

  const files = changedFiles(changes, { videoPath: current.video_path, thumbnailPath: current.thumbnail_path })
  // 검사한 뒤 다른 요청이 경로를 바꿔서 검사하지 않은 새 파일이 끼어들었다면 처음부터 다시 한다.
  if ((files.videoPath !== null && !verified.has(files.videoPath)) ||
      (files.thumbnailPath !== null && !verified.has(files.thumbnailPath))) {
    return { status: 'retry' }
  }
  assertFilesFree(database, files, id)

  const sets = []
  const values = []
  const set = (column, value) => { sets.push(`${column} = ?`); values.push(value) }
  if (changes.title !== undefined && changes.title !== current.title) set('title', changes.title)
  if (changes.description !== undefined && changes.description !== current.description) set('description', changes.description)
  if (files.videoPath !== null) set('video_path', files.videoPath)
  if (changes.thumbnailPath !== undefined && changes.thumbnailPath !== current.thumbnail_path) set('thumbnail_path', changes.thumbnailPath)

  let tagsChanged = false
  if (changes.tagIds !== undefined) {
    const existing = database.prepare('SELECT tag_id FROM video_tags WHERE video_id = ? ORDER BY tag_id').all(id).map(row => row.tag_id)
    const next = [...changes.tagIds].sort((first, second) => first - second)
    tagsChanged = existing.length !== next.length || existing.some((tagId, index) => tagId !== next[index])
    if (tagsChanged) {
      assertTagsExist(database, next)
      database.prepare('DELETE FROM video_tags WHERE video_id = ?').run(id)
      insertTags(database, id, next)
    }
  }

  let quizChanged = false
  if (changes.quiz !== undefined) {
    const existing = loadQuiz(database, id)
    if (changes.quiz === null) {
      if (existing) {
        database.prepare('DELETE FROM quizzes WHERE video_id = ?').run(id) // 보기는 연쇄 삭제된다
        quizChanged = true
      }
    } else if (!existing || !sameQuiz(existing, changes.quiz)) {
      if (existing) database.prepare('DELETE FROM quizzes WHERE video_id = ?').run(id)
      insertQuiz(database, id, changes.quiz)
      quizChanged = true
    }
  }

  if (sets.length > 0 || tagsChanged || quizChanged) {
    database.prepare(`UPDATE videos SET ${[...sets, "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"].join(', ')} WHERE id = ?`).run(...values, id)
  }

  // 교체되어 더 이상 쓰이지 않는 옛 파일. 혹시 다른 영상이 같은 경로를 쓰고 있다면 지우지 않는다.
  const replaced = []
  if (files.videoPath !== null) replaced.push(current.video_path)
  if (changes.thumbnailPath !== undefined && changes.thumbnailPath !== current.thumbnail_path && current.thumbnail_path !== null) replaced.push(current.thumbnail_path)
  const stillUsed = database.prepare(
    'SELECT 1 FROM videos WHERE id IS NOT ? AND (lower(video_path) = lower(?) OR (thumbnail_path IS NOT NULL AND lower(thumbnail_path) = lower(?))) LIMIT 1'
  )
  const replacedPaths = replaced.filter(path => !stillUsed.get(id, path, path))

  return { status: 'ok', replacedPaths }
}

// 과정에서 영상이 빠진 뒤, 남은 영상의 재생 순서를 1부터 빈틈없이 다시 매긴다(순서는 그대로).
// 순서가 작은 것부터 한 줄씩 앞 번호로 옮기면 UNIQUE(course_id, sort_order)와 부딪히지 않는다.
function compactCourseOrder(database, courseId) {
  const rows = database.prepare('SELECT video_id, sort_order FROM course_videos WHERE course_id = ? ORDER BY sort_order').all(courseId)
  const move = database.prepare('UPDATE course_videos SET sort_order = ? WHERE course_id = ? AND video_id = ?')
  rows.forEach((row, index) => {
    if (row.sort_order !== index + 1) move.run(index + 1, courseId, row.video_id)
  })
}

// 영상 1개를 지운다. 반드시 쓰기 트랜잭션(IMMEDIATE) 안에서 부른다.
// 태그·과정 연결·조회·좋아요·댓글·퀴즈·보기는 DB의 연쇄 삭제로 함께 사라지고, 영상이 빠진 과정은 순서를 다시 매긴다.
// 태그와 과정 자체는 남는다.
//
// 결과: { status: 'missing' } 영상이 없음 / { status: 'ok', removedPaths } 삭제 완료.
// removedPaths는 이제 쓰이지 않는 영상·썸네일 파일 경로다(트랜잭션이 성공한 뒤에 지운다).
// 혹시 다른 영상이 같은 경로를 쓰고 있다면 그 파일은 목록에 넣지 않는다.
export function deleteVideo(database, id) {
  if (!database.isTransaction) throw new Error('Video deletion requires an active transaction.')

  const files = readVideoFilePaths(database, id)
  if (files === null) return { status: 'missing' }

  const courseIds = database.prepare('SELECT DISTINCT course_id FROM course_videos WHERE video_id = ? ORDER BY course_id').all(id).map(row => row.course_id)

  database.prepare('DELETE FROM videos WHERE id = ?').run(id)
  for (const courseId of courseIds) compactCourseOrder(database, courseId)

  const stillUsed = database.prepare(
    'SELECT 1 FROM videos WHERE (lower(video_path) = lower(?) OR (thumbnail_path IS NOT NULL AND lower(thumbnail_path) = lower(?))) LIMIT 1'
  )
  const removedPaths = [files.videoPath, files.thumbnailPath].filter(path => path !== null && !stillUsed.get(path, path))
  return { status: 'ok', removedPaths }
}
