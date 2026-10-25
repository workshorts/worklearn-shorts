import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const N = 16384, R = 8, P = 1, KEYLEN = 32

// 저장 형식: scrypt$N$r$p$salt(hex)$hash(hex)
export function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(password, stored) {
  const [scheme, n, r, p, saltHex, hashHex] = String(stored).split('$')
  if (scheme !== 'scrypt') return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p),
  })
  return timingSafeEqual(actual, expected)
}
