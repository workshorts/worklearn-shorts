import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const N = 16384, R = 8, P = 1, KEYLEN = 32
const MAXMEM = 32 * 1024 * 1024
const storedPattern = /^scrypt\$16384\$8\$1\$([0-9a-f]{32})\$([0-9a-f]{64})$/

function deriveKey(password, salt) {
  return scryptSync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM })
}

// Storage format: scrypt$N$r$p$salt(hex)$hash(hex).
export function hashPassword(password) {
  if (typeof password !== 'string') {
    throw new TypeError('Password hashing requires a string.')
  }

  const salt = randomBytes(16)
  const hash = deriveKey(password, salt)
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string' || stored.length !== 114) return false
  const match = storedPattern.exec(stored)
  if (!match) return false

  try {
    // Validate the entire format before decoding hex or deriving a fixed-size key.
    const expected = Buffer.from(match[2], 'hex')
    const actual = deriveKey(password, Buffer.from(match[1], 'hex'))
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}
