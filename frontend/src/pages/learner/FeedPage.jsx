import { useEffect, useState } from 'react'
import FeedVideoCard from '../../components/feed/FeedVideoCard.jsx'
import useFeedNavigation from '../../components/feed/useFeedNavigation.js'
import './feed.css'

// header: 공통 헤더, filters: 태그 필터, renderActions: 조회수·좋아요 UI를 받을 자리.
// 재생할 영상과 음소거 상태는 피드에서 공유, API 호출은 별도 모듈에서 처리
export default function FeedPage({ videos, header, filters, renderActions, emptyContent, notice, onActiveVideoChange }) {
  const [muted, setMuted] = useState(true)
  const { listRef, activeId, activeIndex, goTo, move, onKeyDown } = useFeedNavigation(videos)
  useEffect(() => {
    if (activeIndex >= 0) onActiveVideoChange?.(activeIndex)
  }, [activeIndex, onActiveVideoChange])
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
      <div className="feed-video-list" ref={listRef} tabIndex={0} role="region" aria-label="영상 목록, 위아래 방향키로 이동" onKeyDown={onKeyDown}>
        {videos.length ? videos.map((video, index) => <div className="feed-video-slide" data-video-id={video.id} key={video.id}>
          <FeedVideoCard video={video} renderActions={renderActions}
            isActive={video.id === activeId} muted={muted} onRequestPlay={() => goTo(index)} onMutedChange={setMuted} />
        </div>) : emptyContent || <p className="feed-empty">등록된 영상이 없습니다.</p>}
      </div>
      {!!videos.length && <>
        <nav className="feed-navigation" aria-label="영상 이동">
          <button type="button" aria-label="이전 영상" disabled={activeIndex <= 0} onClick={() => move(-1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button>
          <button type="button" aria-label="다음 영상" disabled={activeIndex >= videos.length - 1} onClick={() => move(1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button>
        </nav>
        <p className="feed-scroll-hint">스크롤해서 다음 영상 보기</p>
      </>}
      {notice}
    </main>
  </div>
}
