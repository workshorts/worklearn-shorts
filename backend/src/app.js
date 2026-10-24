import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { config } from './config.js'
import { db } from './db.js'
import { ApiError, errors } from './errors.js'

fs.mkdirSync(path.join(config.uploadDir, 'videos'), { recursive: true })
fs.mkdirSync(path.join(config.uploadDir, 'thumbnails'), { recursive: true })

export const app = express()
app.use(express.json())
app.use('/uploads', express.static(config.uploadDir, { index: false }))

app.get('/api/tags', (req, res) => {
  const data = db.prepare('SELECT id, name FROM tags ORDER BY name').all()
  res.json({ data })
})

// 없는 주소
app.use((req, res, next) => next(errors.notFound()))

// 오류 처리: 항상 {code, message, fields} 형식
app.use((err, req, res, next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ code: err.code, message: err.message, fields: err.fields })
  }
  if (err.type === 'entity.parse.failed') {
    const e = errors.invalidJson()
    return res.status(e.status).json({ code: e.code, message: e.message, fields: e.fields })
  }
  console.error(err)
  res.status(500).json({ code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
})