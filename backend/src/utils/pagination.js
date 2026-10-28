import { errors } from '../errors.js'

export function parsePage(value) {
  // Only an omitted query parameter uses the default; blank values are invalid.
  if (value === undefined) return 1

  if (typeof value === 'string' && value !== '' && !/[^0-9]/.test(value)) {
    const page = Number(value)
    if (Number.isSafeInteger(page) && page > 0) return page
  }

  throw errors.validation({ page: '페이지는 1 이상 9007199254740991 이하의 정수로 입력하세요.' })
}

export function parseLimit(value) {
  // Reject invalid supplied values instead of silently applying or clamping defaults.
  if (value === undefined) return 20

  if (typeof value === 'string' && value !== '' && !/[^0-9]/.test(value)) {
    const limit = Number(value)
    if (Number.isSafeInteger(limit) && limit >= 1 && limit <= 50) return limit
  }

  throw errors.validation({ limit: '페이지당 항목 수는 1 이상 50 이하의 정수로 입력하세요.' })
}
