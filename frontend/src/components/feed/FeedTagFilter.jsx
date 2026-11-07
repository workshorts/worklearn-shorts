import { useEffect, useState } from 'react'
import { getFeedTags } from '../../api/feedApi.js'

export default function FeedTagFilter({ selectedId, onSelect }) {
  const [tags, setTags] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    getFeedTags({ signal: controller.signal }).then((result) => { if (!controller.signal.aborted) setTags(result.data) })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [attempt])
  return <div className="feed-tag-filter">
    <div className="feed-tag-options" role="group" aria-label="영상 태그 필터">
      <button type="button" aria-pressed={selectedId === null} onClick={() => onSelect(null)}>전체</button>
      {tags.map((tag) => <button type="button" key={tag.id} aria-pressed={selectedId === tag.id} onClick={() => onSelect(tag.id)}>{tag.name}</button>)}
      {selectedId !== null && !loading && !tags.some((tag) => tag.id === selectedId) && <span className="feed-tag-message">선택한 태그 #{selectedId}</span>}
    </div>
    {loading && <p className="feed-tag-message" role="status">태그를 불러오는 중…</p>}
    {error && <p className="feed-tag-message" role="alert">태그를 불러오지 못했습니다. <button type="button" onClick={() => { setError(''); setLoading(true); setAttempt((old) => old + 1) }}>다시 시도</button></p>}
  </div>
}
