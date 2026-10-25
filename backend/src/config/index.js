import './env.js'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const backendDirectory = fileURLToPath(new URL('../../', import.meta.url))

// 허용할 화면 주소. 쉼표로 여러 개를 적을 수 있고, 끝의 / 는 지운다.
const allowedOrigins = (process.env.ALLOWED_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean)

export const config = {
  port: Number(process.env.PORT) || 3000,
  uploadDir: resolve(backendDirectory, process.env.UPLOAD_DIR || './uploads'),
  authSecret: process.env.AUTH_SECRET || '',
  allowedOrigins,
  sessionHours: Number(process.env.ADMIN_SESSION_HOURS) || 8,
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  loginMaxFails: Number(process.env.LOGIN_MAX_FAILS) || 5,
  loginWindowMinutes: Number(process.env.LOGIN_WINDOW_MINUTES) || 15,
}
