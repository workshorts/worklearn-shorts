import { Router } from 'express'
import { getDb } from '../db/client.js'
import { withTransaction } from '../db/transaction.js'
import { loadVideos } from '../db/video-queries.js'
import { errors } from '../errors.js'
import { parseLimit, parsePage } from '../utils/pagination.js'
import { parseResourceId } from '../utils/resource-id.js'
import { readOptionalVisitorId } from '../utils/visitor-id.js'

export const coursesRouter = Router()

// GET /api/courses - 학습과정 목록 (id 내림차순)
coursesRouter.get('/', (req, res) => {
  const page = parsePage(req.query.page)
  const limit = parseLimit(req.query.limit)

  // 총 개수와 목록을 같은 시점의 데이터로 읽는다
  const { total, rows } = withTransaction(getDb(), database => ({
    total: database.prepare('SELECT COUNT(*) AS count FROM courses').get().count,
    rows: database.prepare(`SELECT c.id, c.name, c.description, c.created_at, c.updated_at,
        (SELECT COUNT(*) FROM course_videos cv WHERE cv.course_id = c.id) AS video_count
      FROM courses c ORDER BY c.id DESC LIMIT ? OFFSET ?`).all(limit, (page - 1) * limit)
  }), { mode: 'DEFERRED' })

  res.json({
    data: rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      videoCount: row.video_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })),
    page,
    limit,
    total
  })
})

// GET /api/courses/:id - 학습과정 상세 (영상은 학습 순서대로)
coursesRouter.get('/:id', (req, res) => {
  const id = parseResourceId(req.params.id)
  const visitorId = readOptionalVisitorId(req)

  const { course, videos } = withTransaction(getDb(), database => {
    const found = database.prepare(
      'SELECT id, name, description, created_at, updated_at FROM courses WHERE id = ?'
    ).get(id)
    if (!found) return { course: null, videos: [] }

    return {
      course: found,
      videos: loadVideos(database, {
        joins: 'JOIN course_videos cv ON cv.video_id = v.id',
        extraColumns: ', cv.sort_order AS sort_order',
        where: 'WHERE cv.course_id = ?',
        orderBy: 'cv.sort_order',
        params: [id],
        visitorId,
        mapExtra: row => ({ sortOrder: row.sort_order })
      })
    }
  }, { mode: 'DEFERRED' })

  if (course === null) throw errors.notFound('학습과정을 찾을 수 없습니다.')

  res.json({
    id: course.id,
    name: course.name,
    description: course.description,
    videoCount: videos.length,
    createdAt: course.created_at,
    updatedAt: course.updated_at,
    videos
  })
})
