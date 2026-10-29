import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import multer from 'multer'
import { config } from '../config/index.js'
import { errors } from '../errors.js'
import { UPLOAD_RULES, createIncomingPath, ensureUploadDirectories, isUploadKind } from '../lib/uploads.js'

const MULTIPART_OVERHEAD_BYTES = 1024 * 1024
const MAX_REQUEST_BYTES = UPLOAD_RULES.video.limit + MULTIPART_OVERHEAD_BYTES

const kindError = message => errors.validation({ kind: message })
const fileError = message => errors.validation({ file: message })

// 받는 동안 크기를 세고 제한을 넘으면 바로 끊는 저장 방식. 파일은 임시 위치에만 쓴다.
const incomingStorage = {
  _handleFile(req, file, callback) {
    const rule = UPLOAD_RULES[req.uploadKind]
    const path = createIncomingPath(config.uploadDir)
    req.uploadTempPaths.push(path)

    let size = 0
    const counter = new Transform({
      transform(chunk, encoding, done) {
        size += chunk.length
        if (size > rule.limit) return done(errors.fileTooLarge())
        done(null, chunk)
      }
    })

    ensureUploadDirectories(config.uploadDir)
      .then(() => {
        // 폴더를 만드는 사이에 연결이 끊겼다면 파일을 아예 만들지 않는다.
        if (req.uploadClosed) throw new Error('Request aborted')
        return pipeline(file.stream, counter, createWriteStream(path, { flags: 'wx', mode: 0o644 }))
      })
      .then(
        () => callback(null, { path, size }),
        // 크기 초과, 연결 끊김, 디스크 오류 등으로 중간에 실패하면 받던 파일을 스스로 지운다.
        error => rm(path, { force: true }).catch(() => {}).finally(() => callback(error))
      )
  },
  _removeFile(req, file, callback) {
    rm(file.path, { force: true }).then(() => callback(null), callback)
  }
}

const parser = multer({
  storage: incomingStorage,
  limits: {
    fileSize: UPLOAD_RULES.video.limit,
    files: 1,
    fields: 5,
    parts: 8,
    fieldSize: 256,
    fieldNameSize: 50
  },
  fileFilter(req, file, callback) {
    // kind 필드는 파일보다 먼저 와야 한다. 파일이 시작되는 시점에 어떤 규칙을 쓸지 알아야 하기 때문이다.
    if (file.fieldname !== 'file') return callback(fileError('파일 필드 이름은 file이어야 합니다.'))
    const kind = req.body?.kind
    if (kind === undefined) return callback(kindError('kind 필드를 file보다 먼저 보내세요.'))
    if (!isUploadKind(kind)) return callback(kindError('kind는 video 또는 thumbnail이어야 합니다.'))
    req.uploadKind = kind
    callback(null, true)
  }
}).single('file')

// 멀티파트가 아니면 본문을 읽기 전에 거절한다.
export function requireMultipart(req, res, next) {
  const type = String(req.headers['content-type'] || '').toLowerCase()
  if (!type.startsWith('multipart/form-data')) return next(errors.unsupportedMediaType())
  next()
}

// 크기를 미리 알려 주는 요청이 너무 크면 본문을 받지 않고 바로 끊는다.
export function rejectOversizedRequest(req, res, next) {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    res.setHeader('Connection', 'close')
    return next(errors.fileTooLarge())
  }
  next()
}

// 요청이 어떻게 끝나든(성공, 실패, 연결 끊김) 남아 있는 임시 파일을 지운다.
export function cleanupTempFiles(req, res, next) {
  req.uploadTempPaths = []
  req.uploadClosed = false
  res.once('close', () => {
    req.uploadClosed = true
    for (const path of req.uploadTempPaths) rm(path, { force: true }).catch(() => {})
  })
  next()
}

export function receiveUpload(req, res, next) {
  parser(req, res, error => {
    if (!error) return next()
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') return next(errors.fileTooLarge())
      if (error.code === 'LIMIT_UNEXPECTED_FILE') return next(fileError('파일은 file 필드에 하나만 보내세요.'))
      return next(errors.validation({ file: '업로드 요청 형식이 올바르지 않습니다.' }))
    }
    // 멀티파트 형식이 깨진 요청(본문이 중간에 끊김 등)
    if (/Unexpected end of form|Malformed|Boundary not found|Part terminator|Multipart|Request aborted/i.test(String(error.message))) {
      return next(errors.validation({ file: '업로드 요청 형식이 올바르지 않습니다.' }))
    }
    next(error)
  })
}
