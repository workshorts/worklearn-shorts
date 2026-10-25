import { adminRequest } from './adminApi.js'
import { adminPreview } from '../components/admin/adminPreview.js'

// 미리보기에서도 영상 데이터를 공유하여 영상 삭제 등의 변경을 학습과정에도 반영, 예를 들어 관리에서 영상을 삭제하면 학습과정에서도 영상이 빠지게끔
const mock = adminPreview ? import('./mockVideoApi.js') : null
const call = (name, args, request) => mock ? mock.then((module) => module[name](...args)) : request()
export const getCourses = (page = 1, signal) => call('getCourses', [page, signal], () => adminRequest(`courses?page=${page}&limit=20`, { signal }))
export const getCourse = (id, signal) => call('getCourse', [id, signal], () => adminRequest(`courses/${id}`, { signal }))
export const saveCourse = (id, data) => call('saveCourse', [id, data], () => adminRequest(id ? `courses/${id}` : 'courses', { method: id ? 'PUT' : 'POST', body: JSON.stringify(data) }))
export const deleteCourse = (id) => call('deleteCourse', [id], () => adminRequest(`courses/${id}`, { method: 'DELETE' }))
