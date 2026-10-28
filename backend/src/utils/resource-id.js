import { errors } from '../errors.js'

// Validate the whole path parameter before conversion or any database lookup.
export function parseResourceId(value) {
  if (typeof value === 'string' && value !== '' && !/[^0-9]/.test(value)) {
    // Decimal leading zeros refer to the same ID; never trim or coerce other types.
    const id = Number(value)
    if (Number.isSafeInteger(id) && id > 0) return id
  }

  throw errors.validation({ id: 'ID는 1 이상 9007199254740991 이하의 정수로 입력하세요.' })
}
