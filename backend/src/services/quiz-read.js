import { loadQuiz } from '../db/quiz-queries.js'
import { withTransaction } from '../db/transaction.js'
import { assertVideoExists } from '../db/video-existence.js'
import { errors } from '../errors.js'

// Recheck the parent and read the quiz and options from one committed snapshot.
export function loadVideoQuiz(database, { id }) {
  return withTransaction(database, connection => {
    assertVideoExists(connection, id)
    const quiz = loadQuiz(connection, id)
    if (quiz === null) throw errors.notFound('퀴즈를 찾을 수 없습니다.')
    return quiz
  }, { mode: 'DEFERRED' })
}
