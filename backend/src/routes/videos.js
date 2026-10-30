import { Router } from 'express'
import { getDb } from '../db/client.js'
import { validateVideoListRequest } from '../middleware/validateVideoListRequest.js'
import { validateVideoViewRequest } from '../middleware/validateVideoViewRequest.js'
import { loadVideoDetail, loadVideoList } from '../services/video-read.js'
import { recordVideoView } from '../services/video-view.js'
import { parseResourceId } from '../utils/resource-id.js'
import { readOptionalVisitorId } from '../utils/visitor-id.js'

export const videosRouter = Router()

// Validate before opening the database and send success only after the service commits.
videosRouter.post('/:id/view', validateVideoViewRequest, (req, res) => {
  const result = recordVideoView(getDb(), res.locals.videoViewRequest)
  res.json(result)
})

// Public list requests validate input before opening or querying the database.
videosRouter.get('/', validateVideoListRequest, (req, res) => {
  const { page, limit, visitorId } = res.locals.videoListRequest
  const { data, total } = loadVideoList(getDb(), { page, limit, visitorId })
  res.json({ data, page, limit, total })
})

// Public detail requests validate input before opening or querying the database.
videosRouter.get('/:id', (req, res) => {
  const id = parseResourceId(req.params.id)
  const visitorId = readOptionalVisitorId(req)
  const video = loadVideoDetail(getDb(), { id, visitorId })
  res.json(video)
})
