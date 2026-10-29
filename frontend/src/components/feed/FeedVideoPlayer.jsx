// 재생 제어 영역. 자동 재생·활성 영상 전환은 다음 단계에서 여기에 연결한다.
export default function FeedVideoPlayer({ src, poster, title }) {
  return <video
    className="feed-video-player"
    src={src || undefined}
    poster={poster || undefined}
    aria-label={title}
    controls
    muted
    playsInline
    preload="metadata"
  />
}
