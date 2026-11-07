import { errors } from '../errors.js'

// 영상태그 생성 입력을 확인하고 정리한다. 이름은 앞뒤 공백을 지우고 1~30자(DB의 CHECK와 같게 유니코드 문자 단위)여야 한다.
// 표시 이름의 대소문자는 그대로 저장하고, 중복 판단만 normalize_tag_name(앞뒤 공백 제거 + 소문자)으로 한다.
export function parseTagCreate(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw errors.validation({ body: '요청 본문은 JSON 객체여야 합니다.' })
  }

  const fields = Object.create(null)
  for (const key of Object.keys(body)) {
    if (key !== 'name') fields[key] = '허용되지 않는 필드입니다.'
  }

  const name = typeof body.name === 'string' && !body.name.includes('\0') ? body.name.trim() : null
  const length = name === null ? 0 : Array.from(name).length
  if (name === null || length < 1 || length > 30) fields.name = '태그 이름은 1~30자로 입력하세요.'

  if (Object.keys(fields).length > 0) throw errors.validation(fields)
  return { name }
}
