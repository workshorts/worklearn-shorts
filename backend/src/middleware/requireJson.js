import { errors } from '../errors.js'

// Require the exact JSON media type; body and field validation belong to later handlers.
export function requireJson(req, res, next) {
  const type = req.headers['content-type']
  if (typeof type !== 'string' || type.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    return next(errors.unsupportedMediaType())
  }
  next()
}
