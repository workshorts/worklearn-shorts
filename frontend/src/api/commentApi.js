import { learnerRequest } from './learnerApi.js'

export const getComments = (videoId, page = 1, signal) => learnerRequest(`/api/videos/${videoId}/comments?page=${page}&limit=20`, { signal })
export const createComment = (videoId, data) => learnerRequest(`/api/videos/${videoId}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
export const deleteComment = (id, password) => learnerRequest(`/api/comments/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
