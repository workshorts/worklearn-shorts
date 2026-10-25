import { ApiError } from './adminApi.js'

// Development only. Refresh resets the sample data; files stay in browser memory.
let tags = ['엑셀', '개발', '업무자동화', '비즈니스 매너', '기획/PM', '데이터 분석'].map((name, i) => ({ id: i + 1, name }))
const titles = ['실무 엑셀 기초', '웹 개발 입문', '업무 자동화 입문', '직장인 비즈니스 매너', '직장인을 위한 IT 기초', '기획안 · 보고서 작성법', '데이터 분석 입문', '효율적인 커뮤니케이션']
let videos = titles.map((title, i) => ({
  id: i + 1, title, description: `${title}의 핵심을 짧게 배워보세요.`, tagIds: [i % tags.length + 1],
  videoPath: null, thumbnailPath: null, videoUrl: '', thumbnailUrl: '',
  viewCount: [1254, 2480, 1892, 3521, 980, 2114, 3092, 1768][i], likeCount: [98, 215, 173, 320, 64, 201, 278, 142][i],
  likedByMe: false, commentCount: 0, quiz: null,
  createdAt: new Date(Date.UTC(2026, 9, 15 - i)).toISOString(), updatedAt: new Date(Date.UTC(2026, 9, 15 - i)).toISOString(),
}))
let nextId = 9
let nextTagId = 7
let courses = [
  { id: 1, name: '실무 엑셀 기초', description: '실무에서 자주 사용하는 엑셀 기능을 기초부터 차근차근 학습합니다.', videoIds: [1] },
  { id: 2, name: '웹 개발 입문', description: '웹 개발의 기본 개념과 흐름을 배웁니다.', videoIds: [2, 5] },
  { id: 3, name: '업무 자동화 입문', description: '반복되는 업무를 자동화하여 효율적으로 일하는 방법을 배웁니다.', videoIds: [3] },
  { id: 4, name: '직장인 비즈니스 매너', description: '직장 생활에 필요한 비즈니스 매너와 커뮤니케이션을 배웁니다.', videoIds: [4, 8] },
  { id: 5, name: '직장인을 위한 IT 기초', description: '업무에 필요한 IT 기본 지식을 배웁니다.', videoIds: [5] },
  { id: 6, name: '기획안 · 보고서 작성법', description: '설득력 있는 기획안과 보고서를 작성하는 방법을 배웁니다.', videoIds: [6, 7] },
].map((course) => ({ ...course, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }))
let nextCourseId = 7
const uploads = new Map()
const copy = (value) => structuredClone(value)
async function delay(signal) {
  await new Promise((resolve) => setTimeout(resolve, 180))
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
}
const find = (id) => {
  const video = videos.find((v) => v.id === Number(id))
  if (!video) throw new ApiError('영상을 찾을 수 없습니다.', 404)
  return video
}
const dto = (video) => copy({ ...video, tags: tags.filter((tag) => video.tagIds.includes(tag.id)), hasQuiz: !!video.quiz })
export async function getVideos(page, signal) {
  await delay(signal)
  return { data: videos.slice((page - 1) * 20, page * 20).map(dto), page, limit: 20, total: videos.length }
}
export async function getVideo(id, signal) { await delay(signal); return dto(find(id)) }
export async function getTags(signal) { await delay(signal); return { data: copy(tags) } }
export async function createTag(name) {
  await delay()
  name = name.trim()
  if (!name || name.length > 30) throw new ApiError('태그 이름을 1~30자로 입력해 주세요.', 400)
  if (tags.some((tag) => tag.name.toLowerCase() === name.toLowerCase())) throw new ApiError('이미 등록된 태그입니다.', 409)
  const tag = { id: nextTagId++, name }; tags.push(tag); return copy(tag)
}
export async function deleteTag(id) {
  await delay(); tags = tags.filter((tag) => tag.id !== id)
  videos.forEach((v) => { v.tagIds = v.tagIds.filter((tagId) => tagId !== id) })
}
export async function uploadFile(kind, file) {
  await delay()
  const path = `${kind === 'video' ? 'videos' : 'thumbnails'}/${crypto.randomUUID()}.${file.name.split('.').pop()}`
  const url = URL.createObjectURL(file); uploads.set(path, url)
  return { path, url }
}
export async function saveVideo(id, data) {
  await delay()
  if (data.tagIds.some((tagId) => !tags.some((tag) => tag.id === tagId))) throw new ApiError('태그 목록이 변경되었습니다. 다시 선택해 주세요.', 400)
  const old = id ? find(id) : null
  const now = new Date().toISOString()
  const video = { ...(old || { id: nextId++, viewCount: 0, likeCount: 0, likedByMe: false, commentCount: 0, createdAt: now }), ...copy(data), updatedAt: now }
  video.videoUrl = uploads.get(data.videoPath) || old?.videoUrl || ''
  video.thumbnailUrl = data.thumbnailPath ? (uploads.get(data.thumbnailPath) || old?.thumbnailUrl || '') : ''
  video.quiz = data.quiz ? { ...copy(data.quiz), id: video.id, videoId: video.id, options: data.quiz.options.map((o, i) => ({ ...o, id: i + 1, sortOrder: i + 1 })) } : null
  if (old) videos = videos.map((v) => v.id === video.id ? video : v)
  else videos.unshift(video)
  return dto(video)
}
export async function deleteVideo(id) {
  await delay(); const video = find(id)
  for (const path of [video.videoPath, video.thumbnailPath]) {
    if (uploads.has(path)) { URL.revokeObjectURL(uploads.get(path)); uploads.delete(path) }
  }
  videos = videos.filter((v) => v.id !== Number(id))
  courses.forEach((course) => { course.videoIds = course.videoIds.filter((videoId) => videoId !== Number(id)) })
}

const courseSummary = ({ videoIds, ...course }) => copy({ ...course, videoCount: videoIds.length })
const courseDetail = (course) => ({ ...courseSummary(course), videos: course.videoIds.map((id, index) => ({ ...dto(find(id)), sortOrder: index + 1 })) })
function findCourse(id) {
  const course = courses.find((course) => course.id === Number(id))
  if (!course) throw new ApiError('학습과정을 찾을 수 없습니다.', 404)
  return course
}
export async function getCourses(page, signal) {
  await delay(signal)
  return { data: courses.slice((page - 1) * 20, page * 20).map(courseSummary), page, limit: 20, total: courses.length }
}
export async function getCourse(id, signal) { await delay(signal); return courseDetail(findCourse(id)) }
export async function saveCourse(id, data) {
  await delay()
  const name = data.name.trim()
  if (name.length < 2 || name.length > 50 || data.description.length > 300) throw new ApiError('학습과정 이름과 설명을 확인해 주세요.', 400)
  if (!data.videoIds.length || new Set(data.videoIds).size !== data.videoIds.length || data.videoIds.some((id) => !videos.some((video) => video.id === id))) {
    throw new ApiError('중복 없이 영상을 1개 이상 선택해 주세요. 삭제된 영상이 있는지 확인해 주세요.', 400)
  }
  const old = id ? findCourse(id) : null
  const course = { ...(old || { id: nextCourseId++, createdAt: new Date().toISOString() }), name, description: data.description, videoIds: [...data.videoIds], updatedAt: new Date().toISOString() }
  if (old) courses = courses.map((item) => item.id === course.id ? course : item)
  else courses.unshift(course)
  return courseDetail(course)
}
export async function deleteCourse(id) {
  await delay(); findCourse(id)
  courses = courses.filter((course) => course.id !== Number(id))
}
