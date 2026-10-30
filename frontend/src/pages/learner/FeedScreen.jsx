import { useCallback } from 'react'
import useVideoFeed from '../../components/feed/useVideoFeed.js'
import FeedPage from './FeedPage.jsx'

// 실제 데이터 로딩과 화면 구성을 분리한다.
export default function FeedScreen() {
  const { videos, loading, error, loadingMore, moreError, loadMore, reload } = useVideoFeed()
  const handleActiveVideo = useCallback((index) => {
    if (index >= Math.max(0, videos.length - 3) && !moreError) loadMore()
  }, [videos.length, moreError, loadMore])
  const emptyContent = loading ? <div className="feed-state" role="status">영상을 불러오고 있습니다.</div>
    : error ? <div className="feed-state" role="alert"><p>{error}</p><button type="button" onClick={reload}>다시 시도</button></div> : undefined
  const notice = moreError ? <div className="feed-load-notice" role="alert"><span>다음 영상을 불러오지 못했습니다.</span><button type="button" onClick={loadMore}>다시 시도</button></div>
    : loadingMore ? <div className="feed-load-notice" role="status">다음 영상을 불러오는 중…</div> : null
  return <FeedPage videos={videos} emptyContent={emptyContent} notice={notice} onActiveVideoChange={handleActiveVideo} />
}
