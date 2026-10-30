import FeedVideoPlayer from './FeedVideoPlayer.jsx'
import FeedVideoStats from './FeedVideoStats.jsx'

// 영상 한 개의 표시 단위. renderActions(video)로 좋아요 등의 UI를 연결한다.
export default function FeedVideoCard({ video, renderActions, isActive, muted, onRequestPlay, onMutedChange }) {
  const titleId = `feed-video-title-${video.id}`
  return <article className="feed-video-card" aria-labelledby={titleId}>
    <div className="feed-video-frame">
      <FeedVideoPlayer key={video.videoUrl} src={video.videoUrl} poster={video.thumbnailUrl} title={video.title}
        isActive={isActive} muted={muted} onRequestPlay={onRequestPlay} onMutedChange={onMutedChange} />
      <div className="feed-video-shade" aria-hidden="true" />
      <div className="feed-video-info">
        <h2 id={titleId}>{video.title}</h2>
        {video.description && <p>{video.description}</p>}
        {!!video.tags?.length && <ul className="feed-video-tags" aria-label="영상 태그">{video.tags.map((tag) => <li key={tag.id}>#{tag.name}</li>)}</ul>}
      </div>
    </div>
    <aside className="feed-video-actions" aria-label={`${video.title} 반응`}>{renderActions ? renderActions(video) : <FeedVideoStats video={video} />}</aside>
  </article>
}
