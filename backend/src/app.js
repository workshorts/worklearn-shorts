import express from 'express'
import { config } from './config/index.js'
import { ApiError, errors } from './errors.js'
import { requireAllowedOrigin } from './middleware/requireAllowedOrigin.js'
import { adminAuthRouter } from './routes/adminAuth.js'

export const app = express()

// 관리자 변경 요청은 허용된 Origin에서 온 것만 받는다 (본문을 읽기 전에 확인)
app.use('/api/admin', requireAllowedOrigin)

app.use(express.json())

// 영상·썸네일 파일 제공 (영상 구간 재생도 자동 지원)
app.use('/uploads', express.static(config.uploadDir, { index: false }))

// 관리자 API - 반드시 '없는 주소'보다 위에 둔다
app.use('/api/admin', adminAuthRouter)

// 없는 주소
app.use((req, res, next) => next(errors.notFound()))

// 오류 처리: 항상 {code, message, fields} 형식
app.use((err, req, res, next) => {
  if (err instanceof ApiError) {
    res.set(err.headers)
    return res.status(err.status).json({ code: err.code, message: err.message, fields: err.fields })
  }
  if (err.type === 'entity.parse.failed') {
    const e = errors.invalidJson()
    return res.status(e.status).json({ code: e.code, message: e.message, fields: e.fields })
  }
  console.error(err)
  res.status(500).json({ code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
})
