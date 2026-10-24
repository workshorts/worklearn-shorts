import path from 'node:path'

// backend 폴더 기준으로 경로를 계산한다 (어디서 실행해도 같은 위치)
const backendDir = path.resolve(import.meta.dirname, '..')
const fromBackend = (p) => path.resolve(backendDir, p)

// 허용할 화면 주소. 쉼표로 여러 개를 적을 수 있고, 끝의 / 는 지운다.
const allowedOrigins = (process.env.ALLOWED_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean)

export const config = {
  backendDir,
  port: Number(process.env.PORT) || 3000,
  dbPath: fromBackend(process.env.DB_PATH || './data/app.db'),
  uploadDir: fromBackend(process.env.UPLOAD_DIR || './uploads'),
  authSecret: process.env.AUTH_SECRET || '',
  allowedOrigins,
  sessionHours: Number(process.env.ADMIN_SESSION_HOURS) || 8,
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  loginMaxFails: Number(process.env.LOGIN_MAX_FAILS) || 5,
  loginWindowMinutes: Number(process.env.LOGIN_WINDOW_MINUTES) || 15,
}