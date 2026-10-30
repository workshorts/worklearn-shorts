import { errors } from '../errors.js'

const visitorIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function invalidVisitorId() {
  return errors.validation({ visitorId: '방문자 ID는 올바른 UUID 형식으로 입력하세요.' })
}

export function parseVisitorId(value) {
  // The length check also excludes a trailing newline accepted by a dollar anchor.
  if (typeof value === 'string' && value.length === 36 && visitorIdPattern.test(value)) {
    // Normalize only validated input; never trim, repair or coerce other values.
    return value.toLowerCase()
  }

  throw invalidVisitorId()
}

export function readOptionalVisitorId(req) {
  // Node lowercases parsed header names and preserves duplicate names in rawHeaders.
  let occurrences = 0
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === 'x-visitor-id') occurrences += 1
  }

  // Reject duplicates even when a parser keeps only one of their identical values.
  if (occurrences > 1) throw invalidVisitorId()
  if (occurrences === 0 && !Object.hasOwn(req.headers, 'x-visitor-id')) return null

  return parseVisitorId(req.headers['x-visitor-id'])
}

export function readRequiredVisitorId(req) {
  // Reuse normalization and duplicate detection; only header absence differs.
  const visitorId = readOptionalVisitorId(req)
  if (visitorId === null) throw invalidVisitorId()
  return visitorId
}
