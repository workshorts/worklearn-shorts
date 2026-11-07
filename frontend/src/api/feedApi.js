import { ApiError } from './adminApi.js'
import { learnerRequest } from './learnerApi.js'

// 개발용 미리보기를 끄면 같은 화면에서 실제 사용자 영상 API를 호출
export async function getFeedVideos({ page = 1, limit = 20, tagId = null, signal } = {}) {
  if (import.meta.env.DEV && import.meta.env.VITE_FEED_PREVIEW === 'true') {
    const { feedPreviewVideos } = await import('../pages/learner/feedPreviewData.js')
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const videos = tagId === null ? feedPreviewVideos : feedPreviewVideos.filter((video) => video.tags.some((tag) => tag.id === tagId))
    return { data: videos.slice((page - 1) * limit, page * limit), page, limit, total: videos.length }
  }
  const query = new URLSearchParams({ page: String(page), limit: String(limit) })
  if (tagId !== null) query.set('tagId', String(tagId))
  return learnerRequest(`/api/videos?${query}`, { signal, visitor: true })
}

export async function getFeedTags({ signal } = {}) {
  if (feedPreview()) {
    const { feedPreviewVideos } = await import('../pages/learner/feedPreviewData.js')
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return { data: [...new Map(feedPreviewVideos.flatMap((video) => video.tags).map((tag) => [tag.id, tag])).values()].sort((a, b) => a.name.localeCompare(b.name, 'ko')) }
  }
  return learnerRequest('/api/tags', { signal })
}

const feedPreview = () => import.meta.env?.DEV === true && import.meta.env?.VITE_FEED_PREVIEW === 'true'

// 영상 번호가 이상하면 요청 전에 막는다.
function videoIdOf(id) {
  if (!Number.isSafeInteger(id) || id < 1) throw new ApiError('영상 번호가 올바르지 않습니다.', 400, { id: '영상 번호는 1 이상의 정수여야 합니다.' }, 'VALIDATION_ERROR')
  return id
}

// POST /api/videos/:id/view → { videoId, viewCount, counted }
// 누적 10초 재생 후 한 번 호출. 같은 방문자가 다시 보내도 서버가 한 번만 센다.
export async function recordVideoView(id, { signal } = {}) {
  const videoId = videoIdOf(id)
  if (feedPreview()) return { videoId, viewCount: null, counted: false }
  return learnerRequest(`/api/videos/${videoId}/view`, { method: 'POST', signal, visitor: true })
}

// PUT·DELETE /api/videos/:id/like → { videoId, likeCount, likedByMe }
// 같은 요청을 여러 번 보내도 결과가 같다(멱등).
export async function setVideoLike(id, liked, { signal } = {}) {
  const videoId = videoIdOf(id)
  if (feedPreview()) return { videoId, likeCount: null, likedByMe: liked }
  return learnerRequest(`/api/videos/${videoId}/like`, { method: liked ? 'PUT' : 'DELETE', signal, visitor: true })
}
