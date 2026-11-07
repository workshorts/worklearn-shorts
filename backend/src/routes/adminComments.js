import { Router } from 'express'
import { deleteCommentAsAdmin } from '../db/admin-comment-writes.js'
import { getDb } from '../db/client.js'
import { withTransaction } from '../db/transaction.js'
import { errors } from '../errors.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { parseResourceId } from '../utils/resource-id.js'

export const adminCommentsRouter = Router()

// 이 아래 라우트는 모두 로그인한 관리자만 쓸 수 있다.
adminCommentsRouter.use(requireAdmin)

// DELETE /api/admin/comments/:id - 관리자 댓글 삭제 (204). 댓글 비밀번호가 필요 없고, 사용자 삭제의 시도 제한도 받지 않는다.
adminCommentsRouter.delete('/:id', (req, res) => {
  const id = parseResourceId(req.params.id)
  if (!withTransaction(getDb(), database => deleteCommentAsAdmin(database, id))) throw errors.notFound('댓글을 찾을 수 없습니다.')
  res.status(204).end()
})
