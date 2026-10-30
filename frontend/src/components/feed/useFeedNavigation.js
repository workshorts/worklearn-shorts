import { useEffect, useRef, useState } from 'react'

export default function useFeedNavigation(videos) {
  const listRef = useRef(null)
  const [visibleId, setVisibleId] = useState(null)
  const activeIndex = videos.findIndex((video) => video.id === visibleId)
  const activeId = activeIndex < 0 ? null : visibleId

  useEffect(() => {
    const list = listRef.current
    const ratios = new Map()
    const ids = new Map(videos.map((video) => [String(video.id), video.id]))
    // 피드 영역에서 60% 이상 보이는 영상만 재생, 경계에서는 모두 멈출 수 있다.
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => ratios.set(entry.target, entry.isIntersecting ? entry.intersectionRatio : 0))
      let best = null, largest = 0.6
      for (const [element, ratio] of ratios) {
        if (ratio >= largest) { best = ids.get(element.dataset.videoId); largest = ratio }
      }
      setVisibleId(best)
    }, { root: list, threshold: [0, 0.25, 0.5, 0.6, 0.75, 1] })
    list.querySelectorAll('.feed-video-slide').forEach((slide) => observer.observe(slide))
    return () => observer.disconnect()
  }, [videos])

  function goTo(index) {
    const list = listRef.current
    if (!list || !videos.length) return
    const target = Math.max(0, Math.min(index, videos.length - 1))
    list.scrollTo({ top: target * list.clientHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }
  function move(delta) {
    const list = listRef.current
    if (list) goTo(Math.round(list.scrollTop / list.clientHeight) + delta)
  }
  function onKeyDown(event) {
    // 버튼의 Space/Enter, 재생 위치 슬라이더의 방향키 동작을 가로채지 않는다.
    if (event.target.closest('button, input, textarea, select, a, [contenteditable="true"]')) return
    const directions = { ArrowDown: 1, PageDown: 1, ArrowUp: -1, PageUp: -1 }
    if (directions[event.key]) { event.preventDefault(); move(directions[event.key]) }
    else if (event.key === 'Home') { event.preventDefault(); goTo(0) }
    else if (event.key === 'End') { event.preventDefault(); goTo(videos.length - 1) }
  }
  return { listRef, activeId, activeIndex, goTo, move, onKeyDown }
}
