import { useState } from 'react'
import FeedVideoCard from '../../components/feed/FeedVideoCard.jsx'
import './feed.css'

// header: 공통 헤더, filters: 태그 필터, renderActions: 조회수·좋아요 UI를 받을 자리.
// 재생할 영상과 음소거 상태는 피드에서 공유, API 호출은 별도 모듈에서 처리
export default function FeedPage({ videos, header, filters, renderActions }) {
  const [selectedId, setSelectedId] = useState(null)
  const [muted, setMuted] = useState(true)
  const activeId = videos.some((video) => video.id === selectedId) ? selectedId : videos[0]?.id
  return <div className="learner-feed-page has-header">
    {/* 아래 헤더는 목업의 '피드 · 학습하기' 메뉴가 들어갈 공통 헤더 자리 */}
    {header || (
      <header className="feed-structure-header">
        <h1>스킬클립</h1>
      </header>
    )}
    <main className="feed-content" aria-label="숏폼 영상 피드">
      <h1 className="feed-sr-only">숏폼 피드</h1>
      {filters && <div className="feed-filters">{filters}</div>}
      <div className="feed-video-list">
        {videos.length ? videos.map((video) => <FeedVideoCard key={video.id} video={video} renderActions={renderActions}
          isActive={video.id === activeId} muted={muted} onRequestPlay={() => setSelectedId(video.id)} onMutedChange={setMuted} />) : <p className="feed-empty">등록된 영상이 없습니다.</p>}
      </div>
    </main>
  </div>
}
