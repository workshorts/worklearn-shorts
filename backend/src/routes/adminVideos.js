import { Router } from 'express'
import { getDb } from '../db/client.js'
import { readAdminVideo } from '../db/admin-video-queries.js'
import { withTransaction } from '../db/transaction.js'
import { createVideo } from '../db/video-writes.js'
import { loadVideos } from '../db/video-queries.js'
import { errors } from '../errors.js'
import { verifyMediaFiles } from '../lib/media-verification.js'
import { parseVideoCreate } from '../lib/video-input.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { requireJson } from '../middleware/requireJson.js'
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

  const video = withTransaction(getDb(), database => readAdminVideo(database, id), { mode: 'DEFERRED' })

  if (video === null) throw errors.notFound('영상을 찾을 수 없습니다.')
  res.json(video)
})

// POST /api/admin/videos - 영상 등록 (영상 + 태그 + 퀴즈를 한 번에 저장)
// 먼저 POST /api/admin/uploads로 올린 파일의 경로를 videoPath·thumbnailPath에 넣는다.
adminVideosRouter.post('/', requireJson, async (req, res) => {
  const input = parseVideoCreate(req.body)
  // 파일 검사는 비동기라 트랜잭션 밖에서 먼저 한다. 태그·중복 확인과 저장은 한 트랜잭션 안에서 한다.
  await verifyMediaFiles(input)

  const video = withTransaction(getDb(), database => readAdminVideo(database, createVideo(database, input)))

  res.status(201).location(`/api/admin/videos/${video.id}`).json(video)
})
