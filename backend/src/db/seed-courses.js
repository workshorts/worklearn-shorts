import { validateSeedMediaPaths } from './seed-media.js'
import { SEED_VIDEOS } from './seed-videos.js'

// 학습과정 시연 데이터: 영상 번호는 SEED_VIDEOS의 순서(0부터)이고, 배열 순서가 곧 학습 순서다.
// 같은 영상이 여러 과정에 들어갈 수 있다(다대다).
const courseDefinitions = [
  { name: '업무 효율 기초', description: '엑셀과 자동화로 일의 속도를 높이는 입문 과정', videos: [0, 2, 7] },
  { name: '개발 시작하기', description: '웹 개발과 IT 기초를 처음부터 차근차근 배우는 과정', videos: [4, 1, 2] },
  { name: '직장인 기본기', description: '매너, 보고서, 커뮤니케이션까지 일하는 방식의 기본', videos: [3, 5, 7] }
]

export const SEED_COURSES = Object.freeze(courseDefinitions.map(({ name, description, videos }) =>
  Object.freeze({
    name,
    description,
    videoPaths: Object.freeze(videos.map(index => SEED_VIDEOS[index].videoPath))
  })
))

// 호출한 쪽이 트랜잭션을 가지고 있어야 한다.
// 이미 있는 과정(이름이 같은 것)은 이름·설명·영상 구성을 그대로 두어 관리자가 고친 내용을 지키지 않는다.
export function insertSeedCourses(database, courses = SEED_COURSES) {
  if (!database.isOpen) {
    throw new Error('Database connection is closed.')
  }
  if (!database.isTransaction) {
    throw new Error('Seed course insertion requires an active transaction.')
  }
  if (!Array.isArray(courses)) {
    throw new TypeError('Seed course insertion requires an array of courses.')
  }

  const candidates = courses.map(course => {
    if (course === null || typeof course !== 'object' || Array.isArray(course)) {
      throw new TypeError('Seed courses must be objects.')
    }
    const { name, description = '', videoPaths } = course
    if (typeof name !== 'string' || name.length < 2 || name.length > 50 || name.includes('\0')) {
      throw new TypeError('Seed course names must contain 2 to 50 characters without null characters.')
    }
    if (typeof description !== 'string' || description.length > 300 || description.includes('\0')) {
      throw new TypeError('Seed course descriptions must contain at most 300 characters without null characters.')
    }
    if (!Array.isArray(videoPaths) || videoPaths.length === 0) {
      throw new TypeError('Seed courses require at least one video path.')
    }
    // 같은 경로가 한 과정에 두 번 들어가면 안 된다. 형식 검사는 영상 시드와 같은 규칙을 쓴다.
    validateSeedMediaPaths(videoPaths.map(videoPath => ({ videoPath })))
    return { name, description, videoPaths }
  })
  if (new Set(candidates.map(({ name }) => name)).size !== candidates.length) {
    throw new TypeError('Seed course names must be unique.')
  }

  // 쓰기 전에 모든 영상을 먼저 찾는다. 없거나 모호하면 아무것도 저장하지 않는다.
  const findVideo = database.prepare('SELECT id FROM videos WHERE video_path = ? COLLATE BINARY LIMIT 2')
  const resolved = candidates.map(candidate => ({
    ...candidate,
    videoIds: candidate.videoPaths.map(videoPath => {
      const rows = findVideo.all(videoPath)
      if (rows.length !== 1) {
        const error = new Error(rows.length === 0 ? 'A seed course references a missing video.' : 'Multiple existing videos match a seed media path.')
        error.code = rows.length === 0 ? 'MISSING_SEED_COURSE_VIDEO' : 'AMBIGUOUS_SEED_VIDEO'
        throw error
      }
      return rows[0].id
    })
  }))

  const findCourse = database.prepare('SELECT id FROM courses WHERE name = ? COLLATE BINARY LIMIT 2')
  const insertCourse = database.prepare('INSERT INTO courses (name, description) VALUES (?, ?)')
  const insertLink = database.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)')

  return resolved.map(({ name, description, videoIds }) => {
    const rows = findCourse.all(name)
    if (rows.length > 1) {
      const error = new Error('Multiple existing courses match a seed course name.')
      error.code = 'AMBIGUOUS_SEED_COURSE'
      throw error
    }
    // 영상 수는 시드 목록 기준이라 이미 있는 과정도 같은 값을 돌려준다(태그 시드와 같은 방식).
    if (rows.length === 1) return { id: rows[0].id, created: false, videoCount: videoIds.length }

    const id = Number(insertCourse.run(name, description).lastInsertRowid)
    videoIds.forEach((videoId, index) => insertLink.run(id, videoId, index + 1))
    return { id, created: true, videoCount: videoIds.length }
  })
}
