import { useCallback } from 'react'
import useVideoFeed from '../../components/feed/useVideoFeed.js'
import useVideoReactions from '../../components/feed/useVideoReactions.jsx'
import FeedPage from './FeedPage.jsx'
import FeedTagFilter from '../../components/feed/FeedTagFilter.jsx'
import LearnerNavigation from '../../components/learner/LearnerNavigation.jsx'

export default function FeedScreen({ navigate, search = '' }) {
  const raw = new URLSearchParams(search).get('tagId')
  const tagId = raw && /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null
  return <FilteredFeed key={tagId ?? 'all'} tagId={tagId} navigate={navigate} search={search} />
}

// 실제 데이터 로딩과 화면 구성을 분리한다.
function FilteredFeed({ tagId, navigate, search }) {
  const { videos, loading, error, loadingMore, moreError, loadMore, reload } = useVideoFeed(tagId)
  const { renderActions, handleWatched } = useVideoReactions()
  const handleActiveVideo = useCallback((index) => {
    if (index >= Math.max(0, videos.length - 3) && !moreError) loadMore()
  }, [videos.length, moreError, loadMore])
  const emptyContent = loading ? <div className="feed-state" role="status">영상을 불러오고 있습니다.</div>
    : error ? <div className="feed-state" role="alert"><p>{error}</p><button type="button" onClick={reload}>다시 시도</button></div>
    : tagId !== null ? <div className="feed-state"><p>이 태그에 등록된 영상이 없습니다.</p><button type="button" onClick={() => selectTag(null)}>전체 영상 보기</button></div> : undefined
  function selectTag(id) {
    const query = new URLSearchParams(search)
    if (id === null) query.delete('tagId')
    else query.set('tagId', String(id))
    navigate(query.size ? `/?${query}` : '/')
  }
  const notice = moreError ? <div className="feed-load-notice" role="alert"><span>다음 영상을 불러오지 못했습니다.</span><button type="button" onClick={loadMore}>다시 시도</button></div>
    : loadingMore ? <div className="feed-load-notice" role="status">다음 영상을 불러오는 중…</div> : null
  return <FeedPage videos={videos} emptyContent={emptyContent} notice={notice} onActiveVideoChange={handleActiveVideo}
    header={<LearnerNavigation navigate={navigate} />} filters={<FeedTagFilter selectedId={tagId} onSelect={selectTag} />}
    renderActions={renderActions} onVideoWatched={handleWatched} />
}
