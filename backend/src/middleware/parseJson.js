import express from 'express'
import { errors } from '../errors.js'

const jsonParser = express.json()

export function parseJson(req, res, next) {
  jsonParser(req, res, error => {
    // Normalize only errors from this parser, never similarly shaped database errors.
    if (error?.status === 415 && (error.type === 'charset.unsupported' || error.type === 'encoding.unsupported')) {
      return next(errors.unsupportedMediaType())
    }
    next(error)
  })
}
