import { Router } from 'express'
import { loadCourseDetail, loadCourseSummaries } from '../db/course-queries.js'
import { getDb } from '../db/client.js'
import { withTransaction } from '../db/transaction.js'
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
  const { total, data } = withTransaction(getDb(), database => loadCourseSummaries(database, { limit, offset: (page - 1) * limit }), { mode: 'DEFERRED' })

  res.json({ data, page, limit, total })
})

// GET /api/courses/:id - 학습과정 상세 (영상은 학습 순서대로)
coursesRouter.get('/:id', (req, res) => {
  const id = parseResourceId(req.params.id)
  const visitorId = readOptionalVisitorId(req)

  const course = withTransaction(getDb(), database => loadCourseDetail(database, id, visitorId), { mode: 'DEFERRED' })
  if (course === null) throw errors.notFound('학습과정을 찾을 수 없습니다.')

  res.json(course)
})
