import { loadVideos } from './video-queries.js'

// 학습과정을 API 응답 모양으로 읽는 공통 도구. 사용자용(GET /api/courses)과 관리자용(GET /api/admin/courses)이 함께 쓴다.
// 트랜잭션은 부르는 쪽이 정한다(이 함수 안에서 새 트랜잭션을 열지 않는다).
const toSummary = row => ({
  id: row.id,
  name: row.name,
  description: row.description,
  videoCount: row.video_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

// 학습과정 목록 한 페이지(id 내림차순)와 전체 개수.
export function loadCourseSummaries(database, { limit, offset }) {
  return {
    total: database.prepare('SELECT COUNT(*) AS count FROM courses').get().count,
    data: database.prepare(`SELECT c.id, c.name, c.description, c.created_at, c.updated_at,
        (SELECT COUNT(*) FROM course_videos cv WHERE cv.course_id = c.id) AS video_count
      FROM courses c ORDER BY c.id DESC LIMIT ? OFFSET ?`).all(limit, offset).map(toSummary)
  }
}

// 학습과정 1개와 영상(학습 순서대로, sortOrder 포함)을 읽는다. 없으면 null.
// visitorId가 있으면 영상별 likedByMe가 채워지고, 없으면(관리자) 모두 false다.
export function loadCourseDetail(database, id, visitorId = null) {
  const course = database.prepare('SELECT id, name, description, created_at, updated_at FROM courses WHERE id = ?').get(id)
  if (!course) return null

  const videos = loadVideos(database, {
    joins: 'JOIN course_videos cv ON cv.video_id = v.id',
    extraColumns: ', cv.sort_order AS sort_order',
    where: 'WHERE cv.course_id = ?',
    orderBy: 'cv.sort_order',
    params: [id],
    visitorId,
    mapExtra: row => ({ sortOrder: row.sort_order })
  })

  return {
    id: course.id,
    name: course.name,
    description: course.description,
    videoCount: videos.length,
    createdAt: course.created_at,
    updatedAt: course.updated_at,
    videos
  }
}
