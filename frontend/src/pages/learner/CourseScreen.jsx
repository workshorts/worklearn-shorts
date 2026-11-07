import { useEffect, useState } from 'react'
import { getLearningCourse, getLearningCourses } from '../../api/learnerApi.js'
import { markStarted, markCompleted, readProgress, summarizeCourse } from '../../lib/courseProgress.js'
import LearnerNavigation from '../../components/learner/LearnerNavigation.jsx'
import FeedVideoCard from '../../components/feed/FeedVideoCard.jsx'
import useVideoReactions from '../../components/feed/useVideoReactions.jsx'
import CommentSheet from '../../components/feed/CommentSheet.jsx'
import QuizSheet from '../../components/feed/QuizSheet.jsx'
import './feed.css'
import './learning.css'

function Link({ to, navigate, children, ...props }) {
  return <a href={to} {...props} onClick={(event) => { if (!event.button && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(to) } }}>{children}</a>
}
function Progress({ value }) {
  return <div className="learning-progress"><progress max={100} value={value} aria-label="학습 진도" /><strong>{value}%</strong></div>
}
function Status({ error, retry }) {
  return <div className="learning-state" role={error ? 'alert' : 'status'}>{error ? <><p>{error}</p><button type="button" onClick={retry}>다시 시도</button></> : '학습과정을 불러오는 중…'}</div>
}

export function CourseList({ navigate }) {
  const [result, setResult] = useState(null)
  const [page, setPage] = useState(1)
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    // 학습 기록이 있는 과정은 상세 조회로 현재 포함된 영상 ID를 확인
    // 과정에서 제거된 영상의 완료 기록은 진도율 계산에서 제외
    getLearningCourses({ page, signal: controller.signal }).then(async (data) => {
      const progress = readProgress()
      const courses = await Promise.all(data.data.map(async (course) => {
        if (!progress.courses[course.id]) return { ...course, percent: 0 }
        try { const detail = await getLearningCourse(course.id, { signal: controller.signal }); return { ...course, percent: summarizeCourse(detail, progress.courses[course.id]).percent } }
        catch { return { ...course, percent: null } }
      }))
      if (!controller.signal.aborted) setResult({ ...data, data: courses })
    }).catch((err) => { if (!controller.signal.aborted) setError(err.message) })
    return () => controller.abort()
  }, [page, attempt])
  function load(next = page) { setResult(null); setError(''); setPage(next); setAttempt((old) => old + 1) }
  return <div className="learning-page"><LearnerNavigation navigate={navigate} active="learning" /><main className="learning-main"><h1>학습하기</h1><p className="learning-lead">실무에 바로 적용할 수 있는 커리큘럼을<br />영상으로 배워보세요.</p>
    {error || !result ? <Status error={error} retry={() => load()} /> : !result.data.length ? <p className="learning-state">등록된 학습과정이 없습니다.</p> : <div className="learning-grid">{result.data.map((course, index) => <Link to={`/paths/${course.id}`} navigate={navigate} className="learning-card" key={course.id}>
      <div className={`learning-cover cover-${index % 3}`} aria-hidden="true"><span>SKILLCLIP</span><strong>{course.name}</strong><small>▷ {course.videoCount}개 영상</small></div><div className="learning-card-info"><h2>{course.name}</h2><p>{course.description}</p>{course.percent === null ? <small>진도를 불러오지 못했습니다.</small> : <Progress value={course.percent} />}</div>
    </Link>)}</div>}
    {result && result.total > result.limit && <nav className="learning-pagination" aria-label="학습과정 페이지"><button disabled={page === 1} onClick={() => load(page - 1)}>이전</button><span>{page} / {Math.ceil(result.total / result.limit)}</span><button disabled={page * result.limit >= result.total} onClick={() => load(page + 1)}>다음</button></nav>}
  </main></div>
}

export function CourseScreen({ id, lesson, navigate }) {
  const [course, setCourse] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [progress, setProgress] = useState(readProgress)
  useEffect(() => {
    const controller = new AbortController()
    getLearningCourse(id, { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) setCourse({ ...data, videos: [...data.videos].sort((a, b) => a.sortOrder - b.sortOrder) }) })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message) })
    return () => controller.abort()
  }, [id, attempt])
  useEffect(() => {
    const sync = () => setProgress(readProgress())
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])
  const summary = course ? summarizeCourse(course, progress.courses[id]) : null
  const startIndex = course ? Math.max(0, course.videos.findIndex((video) => video.id === summary.continueVideoId)) : 0
  if (lesson !== undefined && course && lesson >= 1 && lesson <= course.videos.length) return <CoursePlayer course={course} index={lesson - 1} navigate={navigate} setProgress={setProgress} />
  const invalidLesson = lesson !== undefined && !!course
  return <div className="learning-page"><LearnerNavigation navigate={navigate} active="learning" /><main className="learning-main"><Link to="/paths" navigate={navigate} className="learning-back">← 학습하기</Link>
    {error || !course ? <Status error={error} retry={() => { setError(''); setAttempt((old) => old + 1) }} /> : invalidLesson ? <div className="learning-state"><h1>영상을 찾을 수 없습니다.</h1><Link to={`/paths/${id}`} navigate={navigate}>강의 목록으로</Link></div> : <>
      <section className="learning-summary"><h1>{course.name}</h1><p>{course.description}</p><div>완료 {summary.completedCount}/{summary.totalCount}</div><Progress value={summary.percent} />{!!course.videos.length && <Link className="learning-primary" to={`/paths/${id}/play/${startIndex + 1}`} navigate={navigate}>{summary.isComplete ? '처음부터 다시 보기' : summary.continueVideoId && progress.courses[id] ? '이어보기' : '학습 시작'}</Link>}</section>
      <section className="learning-lessons"><h2>강의 목록 ({course.videos.length})</h2>{!course.videos.length && <p>아직 등록된 영상이 없습니다.</p>}{course.videos.map((video, index) => <Link className="learning-lesson" key={video.id} to={`/paths/${id}/play/${index + 1}`} navigate={navigate}><span>{index + 1}</span>{video.thumbnailUrl && <img src={video.thumbnailUrl} alt="" onError={(e) => { e.currentTarget.hidden = true }} />}<strong>{video.title}</strong><small>{({ completed: '✓ 완료', 'in-progress': '▷ 학습 중', next: '다음 학습', upcoming: '학습 예정' })[summary.items[index].status]}</small></Link>)}</section>
    </>}
  </main></div>
}

function CoursePlayer({ course, index, navigate, setProgress }) {
  const [muted, setMuted] = useState(true)
  const [completed, setCompleted] = useState(null)
  const [replay, setReplay] = useState(0)
  const [commentVideo, setCommentVideo] = useState(null)
  const [quizVideo, setQuizVideo] = useState(null)
  const { renderActions, handleWatched, updateCommentCount } = useVideoReactions({ onOpenComments: setCommentVideo, onOpenQuiz: setQuizVideo })
  const video = course.videos[index]
  const move = (next) => navigate(`/paths/${course.id}/play/${next + 1}`)
  return <div className="learner-feed-page has-header course-play-page"><LearnerNavigation navigate={navigate} active="learning" /><main className="course-play-main"><div className="course-play-heading"><Link to={`/paths/${course.id}`} navigate={navigate}>← {course.name}</Link><span>{index + 1} / {course.videos.length}</span></div>
    <div className="course-play-stage"><FeedVideoCard key={`${video.id}-${replay}`} video={video} isActive muted={muted} onMutedChange={setMuted} loop={false} renderActions={renderActions} onWatched={handleWatched}
      onStarted={() => { setCompleted(null); setProgress(markStarted(course.id, video.id)) }} onEnded={() => { setProgress(markCompleted(course.id, video.id)); setCompleted(video.id) }} /></div>
    <nav className="course-play-controls" aria-label="강의 이동"><button disabled={!index} onClick={() => move(index - 1)}>← 이전 영상</button><Link to={`/paths/${course.id}`} navigate={navigate}>강의 목록</Link><button disabled={index === course.videos.length - 1} onClick={() => move(index + 1)}>다음 영상 →</button></nav>
    {completed === video.id && <div className="course-completion" role="status"><strong>{index === course.videos.length - 1 ? '마지막 영상을 마쳤어요!' : '영상을 끝까지 시청했어요!'}</strong><button onClick={() => { setCompleted(null); setReplay((old) => old + 1) }}>다시 보기</button>{index < course.videos.length - 1 ? <button onClick={() => move(index + 1)}>다음 학습</button> : <Link to={`/paths/${course.id}`} navigate={navigate}>학습 진도 확인</Link>}</div>}
  </main>{commentVideo && <CommentSheet video={commentVideo} onClose={() => setCommentVideo(null)} onCountChange={updateCommentCount} />}{quizVideo && <QuizSheet video={quizVideo} onClose={() => setQuizVideo(null)} />}</div>
}
