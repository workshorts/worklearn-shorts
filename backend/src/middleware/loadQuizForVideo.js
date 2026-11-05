import { getDb } from '../db/client.js'
import { loadVideoQuiz } from '../services/quiz-read.js'

export function loadQuizForVideo(req, res, next) {
  // Publish the quiz only after the entire read transaction commits successfully.
  res.locals.videoQuiz = loadVideoQuiz(getDb(), res.locals.videoQuizRequest)
  next()
}
