import { Router } from 'express'
import { getDb } from '../db/client.js'
import { limitCommentDeleteRequest } from '../middleware/commentRequestLimits.js'
import { requireCommentDeleteTarget } from '../middleware/requireCommentDeleteTarget.js'
import { requireJson } from '../middleware/requireJson.js'
import { validateCommentDeleteRequest } from '../middleware/validateCommentDeleteRequest.js'
import { verifyCommentDeletePassword } from '../middleware/verifyCommentDeletePassword.js'
import { deleteComment } from '../services/comment-delete.js'

export const commentsRouter = Router()

// Invalid input consumes no quota; excessive attempts stop before password verification.
commentsRouter.delete('/:id', requireJson, validateCommentDeleteRequest,
  limitCommentDeleteRequest, requireCommentDeleteTarget, verifyCommentDeletePassword, (req, res) => {
    deleteComment(getDb(), res.locals.verifiedCommentDeleteTarget)
    res.status(204).end()
  })
