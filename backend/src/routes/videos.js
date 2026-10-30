import { Router } from 'express'
import { getDb } from '../db/client.js'
import { validateVideoListRequest } from '../middleware/validateVideoListRequest.js'
import { loadVideoDetail, loadVideoList } from '../services/video-read.js'
import { parseResourceId } from '../utils/resource-id.js'
import { readOptionalVisitorId } from '../utils/visitor-id.js'

export const videosRouter = Router()

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
