import { useCallback, useEffect, useRef, useState } from 'react'
import { getFeedVideos } from '../../api/feedApi.js'

const initialState = { videos: [], page: 0, hasMore: false, loading: true, loadingMore: false, error: '', moreError: '' }
const hasNext = (result) => result.data.length > 0 && result.page * result.limit < result.total

export default function useVideoFeed() {
  const [state, setState] = useState(initialState)
  const [attempt, setAttempt] = useState(0)
  const nextRequest = useRef(null)
  const locked = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    getFeedVideos({ signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setState({ ...initialState, videos: result.data, page: result.page, hasMore: hasNext(result), loading: false })
    }).catch((error) => {
      if (!controller.signal.aborted) setState({ ...initialState, loading: false, error: error.status === 404 ? '영상 목록을 아직 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.' : error.message })
    })
    return () => { controller.abort(); nextRequest.current?.abort(); locked.current = false }
  }, [attempt])

  const loadMore = useCallback(async () => {
    if (locked.current || state.loading || state.loadingMore || !state.hasMore) return
    locked.current = true
    const controller = new AbortController()
    nextRequest.current = controller
    setState((old) => ({ ...old, loadingMore: true, moreError: '' }))
    try {
      const result = await getFeedVideos({ page: state.page + 1, signal: controller.signal })
      if (!controller.signal.aborted) setState((old) => ({
        ...old, videos: [...new Map([...old.videos, ...result.data].map((video) => [video.id, video])).values()],
        page: result.page, hasMore: hasNext(result), loadingMore: false,
      }))
    } catch (error) {
      if (!controller.signal.aborted) setState((old) => ({ ...old, loadingMore: false, moreError: error.message }))
    } finally {
      if (nextRequest.current === controller) { nextRequest.current = null; locked.current = false }
    }
  }, [state.page, state.hasMore, state.loading, state.loadingMore])

  function reload() { setState(initialState); setAttempt((old) => old + 1) }
  return { ...state, loadMore, reload }
}
