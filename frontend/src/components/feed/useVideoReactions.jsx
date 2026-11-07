import { useCallback, useEffect, useRef, useState } from 'react'
import { recordVideoView, setVideoLike } from '../../api/feedApi.js'
import { addWatchTime } from '../../lib/watchTime.js'
import FeedVideoActions from './FeedVideoActions.jsx'

// 좋아요·조회수 상태를 영상 ID별로 관리한다.
// - 좋아요: 누르는 즉시 화면에 반영하고, 서버 응답 값으로 맞춘다. 실패하면 되돌린다.
// - 조회수: 영상별 누적 재생 10초가 되면 한 번 기록한다. 서버도 방문자당 한 번만 센다.
export default function useVideoReactions({ onOpenComments } = {}) {
  const [changes, setChanges] = useState({})   // id → { likeCount, likedByMe, viewCount }
  const [pending, setPending] = useState({})   // id → true (좋아요 요청 중)
  const [errors, setErrors] = useState({})     // id → 오류 문구
  const watched = useRef(new Map())            // id → 누적 재생 초
  const recorded = useRef(new Set())           // 조회 기록을 보냈거나 보내는 중인 영상
  const errorTimers = useRef(new Map())
  const likeRequests = useRef(new Set())
  useEffect(() => {
    const timers = errorTimers.current
    return () => { timers.forEach(clearTimeout); timers.clear() }
  }, [])

  const patch = useCallback((id, values) => setChanges((old) => ({ ...old, [id]: { ...old[id], ...values } })), [])
  const showError = useCallback((id, message) => {
    setErrors((old) => ({ ...old, [id]: message }))
    clearTimeout(errorTimers.current.get(id))
    errorTimers.current.set(id, setTimeout(() => setErrors((old) => { const next = { ...old }; delete next[id]; return next }), 3000))
  }, [])

  const handleWatched = useCallback((video, seconds) => {
    if (recorded.current.has(video.id)) return
    const { total, reached } = addWatchTime(watched.current.get(video.id) ?? 0, seconds)
    watched.current.set(video.id, total)
    if (!reached) return
    recorded.current.add(video.id)
    recordVideoView(video.id).then((result) => {
      if (Number.isFinite(result.viewCount)) patch(video.id, { viewCount: result.viewCount })
    }).catch(() => {
      // 실패하면 다음에 다시 10초를 보면 재시도한다. 화면은 막지 않는다.
      recorded.current.delete(video.id)
      watched.current.set(video.id, 0)
    })
  }, [patch])

  const toggleLike = useCallback(async (video) => {
    if (likeRequests.current.has(video.id)) return
    likeRequests.current.add(video.id)
    const liked = !video.likedByMe
    const before = { likeCount: video.likeCount, likedByMe: video.likedByMe }
    setPending((old) => ({ ...old, [video.id]: true }))
    patch(video.id, { likedByMe: liked, likeCount: Math.max(0, (video.likeCount ?? 0) + (liked ? 1 : -1)) })
    try {
      const result = await setVideoLike(video.id, liked)
      patch(video.id, Number.isFinite(result.likeCount) ? { likeCount: result.likeCount, likedByMe: result.likedByMe } : { likedByMe: result.likedByMe })
    } catch (error) {
      patch(video.id, before)
      showError(video.id, error.message || '좋아요를 반영하지 못했습니다.')
    } finally {
      likeRequests.current.delete(video.id)
      setPending((old) => { const next = { ...old }; delete next[video.id]; return next })
    }
  }, [patch, showError])

  const renderActions = useCallback((video) => <FeedVideoActions video={{ ...video, ...changes[video.id] }}
    pending={!!pending[video.id]} error={errors[video.id]} onToggleLike={toggleLike} onOpenComments={onOpenComments} />, [changes, pending, errors, toggleLike, onOpenComments])
  const updateCommentCount = useCallback((id, commentCount) => patch(id, { commentCount }), [patch])

  return { renderActions, handleWatched, updateCommentCount }
}
