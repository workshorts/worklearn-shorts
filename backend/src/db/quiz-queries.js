// 영상 1개의 퀴즈를 API 응답 모양(Quiz)으로 읽는다. 퀴즈가 없으면 null이다.
// 보기는 sortOrder 순서이고, 정답 표시(isCorrect)를 포함한다(명세서: 정답 설정 공개).
export function loadQuiz(database, videoId) {
  const quiz = database.prepare('SELECT id, video_id, question FROM quizzes WHERE video_id = ?').get(videoId)
  if (!quiz) return null

  const options = database.prepare(
    'SELECT id, content, sort_order, is_correct FROM quiz_options WHERE quiz_id = ? ORDER BY sort_order'
  ).all(quiz.id)

  return {
    id: quiz.id,
    videoId: quiz.video_id,
    question: quiz.question,
    options: options.map(option => ({
      id: option.id,
      content: option.content,
      sortOrder: option.sort_order,
      isCorrect: option.is_correct === 1
    }))
  }
}
