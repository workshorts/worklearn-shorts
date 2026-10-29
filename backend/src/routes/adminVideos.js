import { Router } from 'express'
import { getDb } from '../db/client.js'
import { loadQuiz } from '../db/quiz-queries.js'
import { withTransaction } from '../db/transaction.js'
import { loadVideos } from '../db/video-queries.js'
import { errors } from '../errors.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { parseLimit, parsePage } from '../utils/pagination.js'
import { parseOptionalId } from '../utils/query-id.js'
import { parseResourceId } from '../utils/resource-id.js'

export const adminVideosRouter = Router()

// 이 아래 라우트는 모두 로그인한 관리자만 쓸 수 있다.
adminVideosRouter.use(requireAdmin)

const TAG_FILTER = 'WHERE EXISTS (SELECT 1 FROM video_tags vt WHERE vt.video_id = v.id AND vt.tag_id = ?)'

// GET /api/admin/videos - 영상 관리 목록 (id 내림차순, ?tagId로 태그 필터)
// 없는 tagId는 오류가 아니라 빈 목록이다(사용자용 영상 목록과 같은 규칙).
adminVideosRouter.get('/', (req, res) => {
  const page = parsePage(req.query.page)
  const limit = parseLimit(req.query.limit)
  const tagId = parseOptionalId(req.query.tagId, 'tagId')

  const where = tagId === null ? '' : TAG_FILTER
  const filterParams = tagId === null ? [] : [tagId]

  // 총 개수와 목록을 같은 시점의 데이터로 읽는다
  const { total, data } = withTransaction(getDb(), database => ({
    total: database.prepare(`SELECT COUNT(*) AS count FROM videos v ${where}`).get(...filterParams).count,
    data: loadVideos(database, { where, params: [...filterParams, limit, (page - 1) * limit], limitSql: 'LIMIT ? OFFSET ?' })
  }), { mode: 'DEFERRED' })

  res.json({ data, page, limit, total })
})

// GET /api/admin/videos/:id - 영상 편집 정보 (Video + tagIds, videoPath, thumbnailPath, quiz)
adminVideosRouter.get('/:id', (req, res) => {
  const id = parseResourceId(req.params.id)

  const video = withTransaction(getDb(), database => {
    const [found] = loadVideos(database, {
      where: 'WHERE v.id = ?',
      params: [id],
      mapExtra: row => ({ videoPath: row.video_path, thumbnailPath: row.thumbnail_path })
    })
    return found ? { ...found, quiz: loadQuiz(database, id) } : null
  }, { mode: 'DEFERRED' })

  if (video === null) throw errors.notFound('영상을 찾을 수 없습니다.')

  // 명세서의 필드 순서: Video 필드 다음에 편집용 필드
  const { videoPath, thumbnailPath, quiz, ...base } = video
  res.json({
    ...base,
    tagIds: base.tags.map(tag => tag.id).sort((first, second) => first - second),
    videoPath,
    thumbnailPath,
    quiz
  })
})
