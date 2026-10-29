import { errors } from '../errors.js'

// 선택 쿼리 값(예: ?tagId=3)을 양의 정수로 확인한다.
// 생략하면 null이고, 값이 있는데 정수가 아니면(빈 값, 0, 음수, 소수, 반복된 값 등) 400이다.
export function parseOptionalId(value, field) {
  if (value === undefined) return null

  if (typeof value === 'string' && value !== '' && !/[^0-9]/.test(value)) {
    const id = Number(value)
    if (Number.isSafeInteger(id) && id > 0) return id
  }

  throw errors.validation({ [field]: `${field}는 1 이상 9007199254740991 이하의 정수로 입력하세요.` })
}
