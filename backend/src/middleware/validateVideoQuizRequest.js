import { parseResourceId } from '../utils/resource-id.js'

export function validateVideoQuizRequest(req, res, next) {
  const id = parseResourceId(req.params.id)
  // Public quizzes require only the video ID, without visitor or authentication input.
  res.locals.videoQuizRequest = { id }
  next()
}
