import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config/index.js'

const toB64 = (data) => Buffer.from(data).toString('base64url')
const sign = (text) => createHmac('sha256', config.authSecret).update(text).digest()

// 로그인한 관리자 ID와 만료 시각을 담고, 서버만 아는 키로 서명한 토큰을 만든다
export function createAdminToken(adminId) {
  const exp = Math.floor(Date.now() / 1000) + config.sessionHours * 3600
  const payload = toB64(JSON.stringify({ sub: adminId, exp: exp }))
  return payload + '.' + toB64(sign(payload))
}

// 서명과 만료를 확인한다. 올바르면 { adminId, exp }, 아니면 null
export function verifyAdminToken(token) {
  if (typeof token !== 'string') return null
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return null

  const expected = sign(payload)
  const actual = Buffer.from(signature, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof data.sub !== 'number' || data.exp < Math.floor(Date.now() / 1000)) return null
    return { adminId: data.sub, exp: data.exp }
  } catch {
    return null
  }
}
