import { Router } from 'express'
import { getDb } from '../db/client.js'
import { createTag, deleteTag } from '../db/tag-writes.js'
import { withTransaction } from '../db/transaction.js'
import { errors } from '../errors.js'
import { parseTagCreate } from '../lib/tag-input.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { requireJson } from '../middleware/requireJson.js'
import { parseResourceId } from '../utils/resource-id.js'

export const adminTagsRouter = Router()

// 이 아래 라우트는 모두 로그인한 관리자만 쓸 수 있다.
adminTagsRouter.use(requireAdmin)

// POST /api/admin/tags - 영상태그 생성 (201 { id, name })
adminTagsRouter.post('/', requireJson, (req, res) => {
  const { name } = parseTagCreate(req.body)
  const tag = withTransaction(getDb(), database => createTag(database, name))
  res.status(201).location(`/api/tags`).json(tag)
})

// DELETE /api/admin/tags/:id - 영상태그 삭제 (204). 영상의 태그 연결만 사라지고 영상은 그대로다.
adminTagsRouter.delete('/:id', (req, res) => {
  const id = parseResourceId(req.params.id)
  if (!withTransaction(getDb(), database => deleteTag(database, id))) throw errors.notFound('태그를 찾을 수 없습니다.')
  res.status(204).end()
})
