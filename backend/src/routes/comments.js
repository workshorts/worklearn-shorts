import { Router } from 'express'
import { limitCommentDeleteRequest } from '../middleware/commentRequestLimits.js'
import { requireCommentDeleteTarget } from '../middleware/requireCommentDeleteTarget.js'
import { requireJson } from '../middleware/requireJson.js'
import { validateCommentDeleteRequest } from '../middleware/validateCommentDeleteRequest.js'

export const commentsRouter = Router()

// Invalid input consumes no quota; excessive attempts stop before password verification.
commentsRouter.delete('/:id', requireJson, validateCommentDeleteRequest,
  limitCommentDeleteRequest, requireCommentDeleteTarget)
