import { Router } from 'express'
import { getDb } from '../db/client.js'
import { loadCourseDetail, loadCourseSummaries } from '../db/course-queries.js'
import { createCourse, deleteCourse, replaceCourse } from '../db/course-writes.js'
import { withTransaction } from '../db/transaction.js'
import { errors } from '../errors.js'
import { parseCourseInput } from '../lib/course-input.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { requireJson } from '../middleware/requireJson.js'
import { parseLimit, parsePage } from '../utils/pagination.js'
import { parseResourceId } from '../utils/resource-id.js'

export const adminCoursesRouter = Router()

// 이 아래 라우트는 모두 로그인한 관리자만 쓸 수 있다.
adminCoursesRouter.use(requireAdmin)

const notFound = () => errors.notFound('학습과정을 찾을 수 없습니다.')

// GET /api/admin/courses - 학습과정 관리 목록 (id 내림차순)
adminCoursesRouter.get('/', (req, res) => {
  const page = parsePage(req.query.page)
  const limit = parseLimit(req.query.limit)
  const { total, data } = withTransaction(getDb(), database => loadCourseSummaries(database, { limit, offset: (page - 1) * limit }), { mode: 'DEFERRED' })
  res.json({ data, page, limit, total })
})

// GET /api/admin/courses/:id - 편집 정보 (영상은 학습 순서대로, sortOrder 포함)
adminCoursesRouter.get('/:id', (req, res) => {
  const id = parseResourceId(req.params.id)
  const course = withTransaction(getDb(), database => loadCourseDetail(database, id), { mode: 'DEFERRED' })
  if (course === null) throw notFound()
  res.json(course)
})

// POST /api/admin/courses - 학습과정 생성. videoIds의 배열 순서대로 sortOrder 1부터 저장한다.
adminCoursesRouter.post('/', requireJson, (req, res) => {
  const input = parseCourseInput(req.body)
  const course = withTransaction(getDb(), database => loadCourseDetail(database, createCourse(database, input)))
  res.status(201).location(`/api/admin/courses/${course.id}`).json(course)
})

// PUT /api/admin/courses/:id - 학습과정 전체 수정. 영상 연결 전체를 한 트랜잭션으로 교체한다.
adminCoursesRouter.put('/:id', requireJson, (req, res) => {
  const id = parseResourceId(req.params.id)
  const input = parseCourseInput(req.body)

  const course = withTransaction(getDb(), database => (
    replaceCourse(database, id, input).status === 'ok' ? loadCourseDetail(database, id) : null
  ))
  if (course === null) throw notFound()
  res.json(course)
})

// DELETE /api/admin/courses/:id - 학습과정 삭제(204). 과정과 영상 연결만 지우고 원본 영상은 남긴다.
adminCoursesRouter.delete('/:id', (req, res) => {
  const id = parseResourceId(req.params.id)
  if (!withTransaction(getDb(), database => deleteCourse(database, id))) throw notFound()
  res.status(204).end()
})
