// API 오류를 한 가지 모양으로 만든다: { code, message, fields }
export class ApiError extends Error {
  constructor(status, code, message, fields = {}, headers = {}) {
    super(message)
    this.status = status
    this.code = code
    this.fields = fields
    this.headers = headers
  }
}

export const errors = {
  validation: (fields = {}, message = '입력값을 확인하세요.') =>
    new ApiError(400, 'VALIDATION_ERROR', message, fields),
  invalidJson: () => new ApiError(400, 'INVALID_JSON', 'JSON 형식이 올바르지 않습니다.'),
  authRequired: () => new ApiError(401, 'AUTH_REQUIRED', '로그인이 필요합니다.'),
  invalidCredentials: () =>
    new ApiError(401, 'INVALID_CREDENTIALS', '아이디 또는 비밀번호가 올바르지 않습니다.'),
  originForbidden: () => new ApiError(403, 'ORIGIN_FORBIDDEN', '허용되지 않은 요청 출처입니다.'),
  notFound: (message = '요청한 대상을 찾을 수 없습니다.') => new ApiError(404, 'NOT_FOUND', message),
  conflict: (code, message) => new ApiError(409, code, message),
  fileTooLarge: () => new ApiError(413, 'FILE_TOO_LARGE', '파일 용량이 너무 큽니다.'),
  unsupportedMediaType: () =>
    new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '지원하지 않는 요청 또는 파일 형식입니다.'),
  // retryAfterSeconds: 몇 초 뒤에 다시 시도할 수 있는지(Retry-After 헤더로 알려 준다)
  rateLimited: (retryAfterSeconds) =>
    new ApiError(
      429,
      'RATE_LIMITED',
      '시도가 너무 많습니다. 잠시 후 다시 시도하세요.',
      {},
      retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {},
    ),
}