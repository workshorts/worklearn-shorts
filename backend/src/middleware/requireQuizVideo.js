import { getDb } from '../db/client.js'
import { assertVideoExists } from '../db/video-existence.js'

export function requireQuizVideo(req, res, next) {
  assertVideoExists(getDb(), res.locals.videoQuizRequest.id)
  next()
}
