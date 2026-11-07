import { errors } from '../errors.js'

// 영상이 모두 실제로 있는지 확인한다(없는 번호는 모두 모아서 알려 준다).
function assertVideosExist(database, videoIds) {
  const placeholders = videoIds.map(() => '?').join(', ')
  const known = new Set(database.prepare(`SELECT id FROM videos WHERE id IN (${placeholders})`).all(...videoIds).map(row => row.id))
  const missing = videoIds.filter(id => !known.has(id))
  if (missing.length > 0) throw errors.validation({ videoIds: `존재하지 않는 영상입니다: ${missing.join(', ')}` })
}

function insertLinks(database, courseId, videoIds) {
  const insert = database.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)')
  // 배열 순서가 곧 학습 순서다(1부터).
  videoIds.forEach((videoId, index) => insert.run(courseId, videoId, index + 1))
}

// 학습과정과 영상 연결을 저장하고 새 과정 id를 돌려준다. 반드시 쓰기 트랜잭션 안에서 부른다.
export function createCourse(database, { name, description, videoIds }) {
  if (!database.isTransaction) throw new Error('Course creation requires an active transaction.')

  assertVideosExist(database, videoIds)
  const id = Number(database.prepare('INSERT INTO courses (name, description) VALUES (?, ?)').run(name, description).lastInsertRowid)
  insertLinks(database, id, videoIds)
  return id
}

// 학습과정을 통째로 바꾼다(이름, 설명, 영상 구성과 순서). 반드시 쓰기 트랜잭션 안에서 부른다.
// 값이 하나도 바뀌지 않으면 아무것도 저장하지 않고 updatedAt도 그대로 둔다(편집기가 모든 값을 보내도 안전).
// 영상 구성이 바뀌면 기존 연결을 모두 지우고 새 순서로 다시 넣는다. 같은 트랜잭션이라 중간에 실패하면 원래대로 돌아간다.
// 결과: { status: 'missing' } 과정이 없음 / { status: 'ok' } 반영 완료.
export function replaceCourse(database, id, { name, description, videoIds }) {
  if (!database.isTransaction) throw new Error('Course replacement requires an active transaction.')

  const current = database.prepare('SELECT id, name, description FROM courses WHERE id = ?').get(id)
  if (!current) return { status: 'missing' }

  const currentVideoIds = database.prepare('SELECT video_id FROM course_videos WHERE course_id = ? ORDER BY sort_order').all(id).map(row => row.video_id)
  const sameVideos = currentVideoIds.length === videoIds.length && currentVideoIds.every((videoId, index) => videoId === videoIds[index])
  if (current.name === name && current.description === description && sameVideos) return { status: 'ok' }

  if (!sameVideos) {
    assertVideosExist(database, videoIds)
    database.prepare('DELETE FROM course_videos WHERE course_id = ?').run(id)
    insertLinks(database, id, videoIds)
  }
  database.prepare("UPDATE courses SET name = ?, description = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(name, description, id)
  return { status: 'ok' }
}

// 학습과정을 지운다. 영상 연결만 연쇄 삭제되고 원본 영상은 그대로 남는다. 지웠으면 true, 없었으면 false.
export function deleteCourse(database, id) {
  if (!database.isTransaction) throw new Error('Course deletion requires an active transaction.')
  return database.prepare('DELETE FROM courses WHERE id = ?').run(id).changes > 0
}
