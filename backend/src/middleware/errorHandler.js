import { ApiError, errors } from '../errors.js'

export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    // A second response cannot be sent safely; close without logging the original error.
    console.error('INTERNAL_ERROR')
    return res.destroy()
  }

  let publicError
  if (err instanceof ApiError) {
    // Only application-created ApiErrors may supply public messages, fields and headers.
    publicError = err
  } else if (err instanceof SyntaxError && err.type === 'entity.parse.failed' && err.status === 400) {
    publicError = errors.invalidJson()
  } else {
    // Never serialize or log native errors, request data, stacks or nested causes.
    console.error('INTERNAL_ERROR')
    return res.status(500).json({
      code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {},
    })
  }

  res.set(publicError.headers)
  return res.status(publicError.status).json({
    code: publicError.code, message: publicError.message, fields: publicError.fields,
  })
}
