// 기본 반응 영역은 수치만 표시, 버튼과 상태 처리는 renderActions(video)로 교체
export default function FeedVideoStats({ video }) {
  const stats = [
    { label: '좋아요', value: video.likeCount, icon: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" /> },
    { label: '댓글', value: video.commentCount, icon: <><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H5l-3 2 1.5-6A8.5 8.5 0 1 1 21 11.5Z" /><path d="M7 11h.01M12 11h.01M17 11h.01" /></> },
    { label: '조회수', value: video.viewCount, icon: <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></> },
  ]
  return <dl className="feed-video-stats">{stats.map(({ label, value, icon }) => <div className="feed-stat" key={label}>
    <dt><span className="feed-stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icon}</svg></span><span className="feed-sr-only">{label}</span></dt>
    <dd>{(value ?? 0).toLocaleString('ko-KR')}</dd>
  </div>)}</dl>
}
