import { learnerRequest } from './learnerApi.js'

// 개발용 미리보기를 끄면 같은 화면에서 실제 사용자 영상 API를 호출
export async function getFeedVideos({ page = 1, limit = 20, signal } = {}) {
  if (import.meta.env.DEV && import.meta.env.VITE_FEED_PREVIEW === 'true') {
    const { feedPreviewVideos } = await import('../pages/learner/feedPreviewData.js')
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return { data: feedPreviewVideos.slice((page - 1) * limit, page * limit), page, limit, total: feedPreviewVideos.length }
  }
  const query = new URLSearchParams({ page: String(page), limit: String(limit) })
  return learnerRequest(`/api/videos?${query}`, { signal, visitor: true })
}
