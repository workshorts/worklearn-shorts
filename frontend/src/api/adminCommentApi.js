import { adminRequest } from './adminApi.js'

// 댓글 조회는 공개 API를 재사용하고 삭제는 관리자 세션으로 인증
export const getCommentVideos = (page = 1, signal) => adminRequest(`videos?page=${page}&limit=20`, { signal })
export const getVideoComments = (videoId, page = 1, signal) => adminRequest(`/api/videos/${videoId}/comments?page=${page}&limit=20`, { signal })
export const deleteCommentAsAdmin = (id) => adminRequest(`comments/${id}`, { method: 'DELETE' })
