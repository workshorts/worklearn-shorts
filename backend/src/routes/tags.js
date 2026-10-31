import { Router } from 'express'
import { getDb } from '../db/client.js'
import { loadTagList } from '../db/tag-queries.js'

export const tagsRouter = Router()

// Public tags are returned in full; a single SELECT already has one read snapshot.
tagsRouter.get('/', (req, res) => {
  res.json({ data: loadTagList(getDb()) })
})
