import { Router } from 'express'
import { requireJson } from '../middleware/requireJson.js'
import { validateCommentDeleteRequest } from '../middleware/validateCommentDeleteRequest.js'

export const commentsRouter = Router()

// Invalid input must stop before the later deletion quota, password check and write.
commentsRouter.delete('/:id', requireJson, validateCommentDeleteRequest)
