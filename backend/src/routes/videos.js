import { Router } from 'express'
import { getDb } from '../db/client.js'
import { loadVideoDetail } from '../services/video-read.js'
import { parseResourceId } from '../utils/resource-id.js'
import { readOptionalVisitorId } from '../utils/visitor-id.js'

export const videosRouter = Router()

// Public detail requests validate input before opening or querying the database.
videosRouter.get('/:id', (req, res) => {
  const id = parseResourceId(req.params.id)
  const visitorId = readOptionalVisitorId(req)
  const video = loadVideoDetail(getDb(), { id, visitorId })
  res.json(video)
})
