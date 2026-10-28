import express from 'express'
import { config } from './config/index.js'
import { errors } from './errors.js'
import { errorHandler } from './middleware/errorHandler.js'
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

// Keep the shared error boundary after every route and the not-found handler.
app.use(errorHandler)
