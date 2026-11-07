import { useEffect, useRef, useState } from 'react'
import { getVideoQuiz } from '../../api/quizApi.js'
import Modal from '../admin/Modal.jsx'
import '../../pages/admin/videos.css'
import './quiz.css'

export default function QuizSheet({ video, onClose }) {
  const [quiz, setQuiz] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [selectedId, setSelectedId] = useState(null)
  const optionRefs = useRef([])
  useEffect(() => {
    const controller = new AbortController()
    getVideoQuiz(video.id, controller.signal).then((data) => {
      if (!controller.signal.aborted) setQuiz(data ? { ...data, options: [...data.options].sort((a, b) => a.sortOrder - b.sortOrder) } : null)
    }).catch((err) => { if (!controller.signal.aborted) setError(err.status === 404 ? '퀴즈가 없거나 삭제되었습니다.' : err.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [video.id, attempt])
  const selected = quiz?.options.find((option) => option.id === selectedId)
  function move(event, index) {
    const offsets = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }
    if (!(event.key in offsets) && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? quiz.options.length - 1 : (index + offsets[event.key] + quiz.options.length) % quiz.options.length
    setSelectedId(quiz.options[next].id); optionRefs.current[next]?.focus()
  }
  return <Modal title="참여형 퀴즈" onClose={onClose} className="quiz-sheet">
    <p className="quiz-introduction">영상에서 배운 내용을 확인해보세요.</p>
    <p className="quiz-video-title">{video.title}</p>
    {loading ? <p className="quiz-state" role="status">퀴즈를 불러오는 중…</p> : error ? <div className="quiz-state" role="alert"><p>{error}</p><button type="button" className="av-button" onClick={() => { setLoading(true); setError(''); setSelectedId(null); setAttempt((old) => old + 1) }}>다시 시도</button></div> : !quiz ? <p className="quiz-state">이 영상에는 퀴즈가 없습니다.</p> : <>
      <h3 className="quiz-question"><span aria-hidden="true">Q.</span>{quiz.question}</h3>
      <div className="quiz-answer-list" role="radiogroup" aria-label="퀴즈 보기">
        {quiz.options.map((option, index) => {
          const checked = option.id === selectedId
          return <button type="button" role="radio" aria-checked={checked} tabIndex={checked || (selectedId === null && index === 0) ? 0 : -1}
            ref={(node) => { optionRefs.current[index] = node }} key={option.id}
            className={`quiz-answer${checked ? option.isCorrect ? ' is-correct' : ' is-wrong' : ''}`}
            onClick={() => setSelectedId(option.id)} onKeyDown={(event) => move(event, index)}>
            <span className="quiz-answer-circle" aria-hidden="true">{checked ? option.isCorrect ? '✓' : '×' : ''}</span><span>{option.content}</span><small aria-hidden="true">{String.fromCharCode(65 + index)}</small>
          </button>
        })}
      </div>
      <div className={`quiz-feedback${selected ? selected.isCorrect ? ' correct' : ' wrong' : ''}`} role="status" aria-live="polite">{selected ? selected.isCorrect ? '정답이에요! 잘 이해하셨네요.' : '오답이에요. 다른 보기를 선택해보세요.' : '정답이라고 생각하는 보기를 골라주세요.'}</div>
      <p className="quiz-reselect-hint">언제든 다른 보기를 선택할 수 있어요.</p>
    </>}
  </Modal>
}
