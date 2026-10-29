import { errors } from '../errors.js'

// 영상 등록(VideoCreate)·수정(VideoPatch) 입력을 확인하고 정리한다. 두 요청이 같은 규칙을 쓰도록 필드별로 나눴다.
// 오류는 하나씩이 아니라 한꺼번에 모아서 400으로 돌려준다.
// 길이는 DB의 CHECK와 같게 글자 수(유니코드 문자)로 센다. 오류 키는 프런트 폼이 화면 칸에 연결하는 이름과 같다
// (videoPath → 영상 파일, thumbnailPath → 썸네일, quiz로 시작 → 퀴즈).
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const VIDEO_PATH = new RegExp(`^videos/${UUID}\\.(mp4|webm)$`, 'i')
export const THUMBNAIL_PATH = new RegExp(`^thumbnails/${UUID}\\.(png|jpg|jpeg|webp)$`, 'i')
const ALLOWED_KEYS = ['title', 'description', 'videoPath', 'thumbnailPath', 'tagIds', 'quiz']
const MAX_TAGS = 100

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const charCount = value => Array.from(value).length
const isText = value => typeof value === 'string' && !value.includes('\0')
// $ 앵커는 끝의 줄바꿈을 허용하므로 일치한 부분 전체가 입력과 같은지 확인한다.
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value

// 각 reader는 올바르면 정리한 값을, 틀리면 fields에 오류를 적고 undefined를 돌려준다.
function readTitle(value, fields) {
  const title = isText(value) ? value.trim() : null
  if (title === null || charCount(title) < 2 || charCount(title) > 100) {
    fields.title = '제목은 2~100자로 입력하세요.'
    return undefined
  }
  return title
}

function readDescription(value, fields) {
  if (!isText(value) || charCount(value) > 500) {
    fields.description = '설명은 500자 이내의 문자열로 입력하세요.'
    return undefined
  }
  return value
}

function readVideoPath(value, fields) {
  if (!matches(VIDEO_PATH, value)) {
    fields.videoPath = '업로드 API가 돌려준 영상 경로(videos/UUID.mp4 또는 .webm)를 입력하세요.'
    return undefined
  }
  return value
}

// null은 '썸네일 없음(기본 이미지)'이다.
function readThumbnailPath(value, fields) {
  if (value === null) return null
  if (!matches(THUMBNAIL_PATH, value)) {
    fields.thumbnailPath = '업로드 API가 돌려준 썸네일 경로(thumbnails/UUID.png, .jpg, .webp)이거나 null이어야 합니다.'
    return undefined
  }
  return value
}

function readTagIds(value, fields) {
  const valid = Array.isArray(value) && value.length <= MAX_TAGS &&
    value.every(id => Number.isSafeInteger(id) && id > 0) && new Set(value).size === value.length
  if (!valid) {
    fields.tagIds = `태그 ID는 중복 없는 1 이상의 정수 배열(최대 ${MAX_TAGS}개)이어야 합니다.`
    return undefined
  }
  return value
}

// null은 '퀴즈 없음'이다.
function readQuiz(value, fields) {
  if (value === null) return null
  if (!isPlainObject(value)) {
    fields.quiz = '퀴즈는 { question, options } 객체이거나 null이어야 합니다.'
    return undefined
  }

  const before = Object.keys(fields).length
  for (const key of Object.keys(value)) {
    if (key !== 'question' && key !== 'options') fields[`quiz.${key}`] = '허용되지 않는 필드입니다.'
  }

  const question = isText(value.question) ? value.question.trim() : null
  if (question === null || charCount(question) < 1 || charCount(question) > 200) fields['quiz.question'] = '퀴즈 질문은 1~200자로 입력하세요.'

  const options = []
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 5) {
    fields['quiz.options'] = '보기는 2~5개의 배열로 입력하세요.'
  } else {
    value.options.forEach((option, index) => {
      const prefix = `quiz.options[${index}]`
      if (!isPlainObject(option)) {
        fields[prefix] = '보기는 { content, isCorrect } 객체여야 합니다.'
        return
      }
      for (const key of Object.keys(option)) {
        if (key !== 'content' && key !== 'isCorrect') fields[`${prefix}.${key}`] = '허용되지 않는 필드입니다.'
      }
      const content = isText(option.content) ? option.content.trim() : null
      if (content === null || charCount(content) < 1 || charCount(content) > 100) fields[`${prefix}.content`] = '보기 내용은 1~100자로 입력하세요.'
      if (typeof option.isCorrect !== 'boolean') fields[`${prefix}.isCorrect`] = 'isCorrect는 true 또는 false여야 합니다.'
      options.push({ content, isCorrect: option.isCorrect })
    })
    if (!fields['quiz.options'] && options.every(option => typeof option.isCorrect === 'boolean') &&
        options.filter(option => option.isCorrect === true).length !== 1) {
      fields['quiz.options'] = '정답은 정확히 1개여야 합니다.'
    }
  }

  return Object.keys(fields).length > before ? undefined : { question, options }
}

function startParsing(body) {
  if (!isPlainObject(body)) throw errors.validation({ body: '요청 본문은 JSON 객체여야 합니다.' })

  const fields = Object.create(null)
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.includes(key)) fields[key] = '허용되지 않는 필드입니다.'
  }
  return fields
}

// POST /api/admin/videos 본문: title·videoPath 필수, 나머지는 기본값을 쓴다.
export function parseVideoCreate(body) {
  const fields = startParsing(body)

  const title = readTitle(body.title, fields)
  const description = body.description === undefined ? '' : readDescription(body.description, fields)
  const videoPath = readVideoPath(body.videoPath, fields)
  const thumbnailPath = body.thumbnailPath === undefined ? null : readThumbnailPath(body.thumbnailPath, fields)
  const tagIds = body.tagIds === undefined ? [] : readTagIds(body.tagIds, fields)
  const quiz = body.quiz === undefined ? null : readQuiz(body.quiz, fields)

  if (Object.keys(fields).length > 0) throw errors.validation(fields)
  return { title, description, videoPath, thumbnailPath, tagIds, quiz }
}

// PATCH /api/admin/videos/:id 본문: 바꿀 항목만 보낸다(생략=유지). 결과에는 보낸 항목만 들어 있다.
// title·description·videoPath·tagIds는 null을 받지 않고, thumbnailPath·quiz만 null(기본 이미지·퀴즈 삭제)을 받는다.
export function parseVideoPatch(body) {
  const fields = startParsing(body)
  const readers = {
    title: readTitle, description: readDescription, videoPath: readVideoPath,
    thumbnailPath: readThumbnailPath, tagIds: readTagIds, quiz: readQuiz
  }

  const changes = {}
  let provided = 0
  for (const [key, read] of Object.entries(readers)) {
    if (body[key] === undefined) continue
    provided += 1
    const value = read(body[key], fields)
    if (value !== undefined) changes[key] = value
  }

  if (provided === 0 && Object.keys(fields).length === 0) fields.body = '바꿀 항목을 1개 이상 보내세요.'
  if (Object.keys(fields).length > 0) throw errors.validation(fields)
  return changes
}
