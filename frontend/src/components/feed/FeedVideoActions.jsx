import { useState } from 'react'
import ShareSheet from './ShareSheet.jsx'
const icons = {
  like: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />,
  comment: <><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H5l-3 2 1.5-6A8.5 8.5 0 1 1 21 11.5Z" /><path d="M7 11h.01M12 11h.01M17 11h.01" /></>,
  view: <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  quiz: <><rect x="3" y="2" width="18" height="18" rx="4" /><path d="m8 20-1 3 5-3M9.5 8a2.5 2.5 0 1 1 4 2c-1 .6-1.5 1-1.5 2M12 16h.01" /></>,
  share: <path d="m14 3 8 8-8 7v-5C8 13 4 16 2 21c0-9 4-13 12-14Z" />,
}
const count = (value) => (value ?? 0).toLocaleString('ko-KR')

function Icon({ name, filled }) {
  return <span className="feed-stat-icon"><svg viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[name]}</svg></span>
}

export default function FeedVideoActions({ video, pending, error, onToggleLike, onOpenComments, onOpenQuiz }) {
  const liked = !!video.likedByMe
  const [sharing, setSharing] = useState(false)
  return <div className="feed-video-stats">
    <div className="feed-stat">
      <button type="button" className={`feed-like-button${liked ? ' is-liked' : ''}`} aria-pressed={liked} disabled={pending}
        aria-label={`좋아요${liked ? ' 취소' : ''}, 현재 ${count(video.likeCount)}개`} onClick={() => onToggleLike(video)}>
        <Icon name="like" filled={liked} />
      </button>
      <span className="feed-stat-value" aria-hidden="true">{count(video.likeCount)}</span>
    </div>
    <div className="feed-stat">
      <button type="button" className="feed-like-button" aria-label={`댓글 열기, 현재 ${count(video.commentCount)}개`} onClick={() => onOpenComments?.(video)}><Icon name="comment" /></button>
      <span className="feed-stat-value">{count(video.commentCount)}</span>
    </div>
    <div className="feed-stat">
      <Icon name="view" /><span className="feed-sr-only">조회수</span>
      <span className="feed-stat-value">{count(video.viewCount)}</span>
    </div>
    {video.hasQuiz && <div className="feed-stat"><button type="button" className="feed-like-button feed-quiz-button" aria-label="퀴즈 열기" onClick={() => onOpenQuiz?.(video)}><Icon name="quiz" /></button><span className="feed-stat-value">퀴즈</span></div>}
    <div className="feed-stat"><button type="button" className="feed-like-button" aria-label="영상 공유" onClick={() => setSharing(true)}><Icon name="share" /></button><span className="feed-stat-value">공유</span></div>
    {sharing && <ShareSheet video={video} onClose={() => setSharing(false)} />}
    {error && <p className="feed-action-error" role="alert">{error}</p>}
  </div>
}
