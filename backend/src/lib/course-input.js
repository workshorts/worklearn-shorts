import { errors } from '../errors.js'

// 학습과정 생성(POST)·전체 수정(PUT) 입력을 확인하고 정리한다. 두 요청이 같은 규칙을 쓴다.
// 오류는 한꺼번에 모아서 400으로 돌려주고, 오류 키(name, description, videoIds)는 프런트 편집기의 칸 이름과 같다.
// 길이는 DB의 CHECK와 같게 글자 수(유니코드 문자)로 센다.
const ALLOWED_KEYS = ['name', 'description', 'videoIds']
const MAX_VIDEOS = 500

const charCount = value => Array.from(value).length
const isText = value => typeof value === 'string' && !value.includes('\0')

// 반환: { name, description, videoIds }. videoIds의 배열 순서가 곧 학습 순서(sortOrder 1부터)다.
export function parseCourseInput(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw errors.validation({ body: '요청 본문은 JSON 객체여야 합니다.' })
  }

  const fields = Object.create(null)
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.includes(key)) fields[key] = '허용되지 않는 필드입니다.'
  }

  const name = isText(body.name) ? body.name.trim() : null
  if (name === null || charCount(name) < 2 || charCount(name) > 50) fields.name = '학습과정 이름은 2~50자로 입력하세요.'

  // 생략하면 빈 설명이다. PUT에서도 생략은 '유지'가 아니라 빈 설명으로 바꾼다(전체 수정).
  let description = ''
  if (body.description !== undefined) {
    if (!isText(body.description) || charCount(body.description) > 300) fields.description = '설명은 300자 이내의 문자열로 입력하세요.'
    else description = body.description
  }

  const ids = body.videoIds
  if (!Array.isArray(ids) || ids.length < 1) {
    fields.videoIds = '학습과정에 영상을 1개 이상 추가해 주세요.'
  } else if (ids.length > MAX_VIDEOS) {
    fields.videoIds = `영상은 최대 ${MAX_VIDEOS}개까지 추가할 수 있습니다.`
  } else if (!ids.every(id => Number.isSafeInteger(id) && id > 0)) {
    fields.videoIds = '영상 ID는 1 이상의 정수여야 합니다.'
  } else if (new Set(ids).size !== ids.length) {
    fields.videoIds = '같은 영상을 두 번 추가할 수 없습니다.'
  }

  if (Object.keys(fields).length > 0) throw errors.validation(fields)
  return { name, description, videoIds: ids }
}
