import { adminRequest } from './adminApi.js'
import { adminPreview } from '../components/admin/adminPreview.js'

// mock api와 실제 api는 동일한 형태의 Promise와 DTO 제공, 리액트 컴포넌트에서는 API 함수만 호출하도록 작성
const mock = adminPreview ? import('./mockVideoApi.js') : null
const call = (name, args, request) => mock ? mock.then((module) => module[name](...args)) : request()
export const getVideos = (page = 1, signal) => call('getVideos', [page, signal], () => adminRequest(`videos?page=${page}&limit=20`, { signal }))
export const getVideo = (id, signal) => call('getVideo', [id, signal], () => adminRequest(`videos/${id}`, { signal }))
export const saveVideo = (id, data) => call('saveVideo', [id, data], () => adminRequest(id ? `videos/${id}` : 'videos', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(data) }))
export const deleteVideo = (id) => call('deleteVideo', [id], () => adminRequest(`videos/${id}`, { method: 'DELETE' }))
export const getTags = (signal) => call('getTags', [signal], () => adminRequest('/api/tags', { signal }))
export const createTag = (name) => call('createTag', [name], () => adminRequest('tags', { method: 'POST', body: JSON.stringify({ name }) }))
export const deleteTag = (id) => call('deleteTag', [id], () => adminRequest(`tags/${id}`, { method: 'DELETE' }))
export const uploadFile = (kind, file) => call('uploadFile', [kind, file], () => {
  const body = new FormData()
  body.append('kind', kind)
  body.append('file', file)
  return adminRequest('uploads', { method: 'POST', body, timeoutMs: 120_000 })
})
