import { errors } from '../errors.js'

const visitorIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseVisitorId(value) {
  // The length check also excludes a trailing newline accepted by a dollar anchor.
  if (typeof value === 'string' && value.length === 36 && visitorIdPattern.test(value)) {
    // Normalize only validated input; never trim, repair or coerce other values.
    return value.toLowerCase()
  }

  throw errors.validation({ visitorId: '방문자 ID는 올바른 UUID 형식으로 입력하세요.' })
}
