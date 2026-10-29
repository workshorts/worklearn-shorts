import FeedVideoCard from '../../components/feed/FeedVideoCard.jsx'
import './feed.css'

// header: 공통 헤더, filters: 태그 필터, renderActions: 조회수·좋아요 UI를 받을 자리.
// 페이지는 영상 데이터만 표시하며 API 호출이나 다른 상태를 관리하지 않는다.
export default function FeedPage({ videos, header, filters, renderActions }) {
  return <div className="learner-feed-page">
    {/* 아래 헤더는 목업의 '피드 · 학습하기' 메뉴가 들어갈 공통 헤더 자리 */}
    {header}
    <main className="feed-content" aria-label="숏폼 영상 피드">
      {filters && <div className="feed-filters">{filters}</div>}
      <div className="feed-video-list">
        {videos.length ? videos.map((video) => <FeedVideoCard key={video.id} video={video} renderActions={renderActions} />) : <p className="feed-empty">등록된 영상이 없습니다.</p>}
      </div>
    </main>
  </div>
}
