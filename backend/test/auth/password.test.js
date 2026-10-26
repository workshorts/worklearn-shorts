import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import test from 'node:test'
import { hashPassword, verifyPassword } from '../../src/lib/password.js'

// Generated with the previous implementation using a fixed, test-only salt.
const legacyHash = 'scrypt$16384$8$1$000102030405060708090a0b0c0d0e0f$d58dbea90e304368cc65b6c23c2c7d39ca8a42cb6ab8db560fc328337184534e'

test('password generation keeps the existing format, random salt and native derivation compatibility', () => {
  const first = hashPassword('Test1234!')
  const second = hashPassword('Test1234!')
  assert.equal(first.length, 114)
  assert.match(first, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/)
  assert.notEqual(first.split('$')[4], second.split('$')[4])
  const [, , , , salt, digest] = first.split('$')
  const previousDerivation = scryptSync('Test1234!', Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 })
  assert.equal(previousDerivation.toString('hex'), digest)
  assert.equal(verifyPassword('Test1234!', first), true)
})

test('password verification accepts a stored hash from the previous implementation without changing it', () => {
  assert.equal(verifyPassword('Test1234!', legacyHash), true)
  assert.equal(verifyPassword('wrong-password', legacyHash), false)
  assert.equal(verifyPassword('Test1234!', legacyHash), true)
})

test('shared password helpers support comment-length inputs without applying the administrator creation minimum', () => {
  const password = '1234'
  const stored = hashPassword(password)
  assert.equal(verifyPassword(password, stored), true)
  assert.equal(verifyPassword('4321', stored), false)
})

test('password helpers preserve whitespace, case and Unicode representation', () => {
  const password = ' e\u0301 Mixed Password '
  const stored = hashPassword(password)
  assert.equal(verifyPassword(password, stored), true)
  assert.equal(verifyPassword(password.trim(), stored), false)
  assert.equal(verifyPassword(password.toLowerCase(), stored), false)
  assert.equal(verifyPassword(password.normalize('NFC'), stored), false)
})

test('password verification rejects missing, empty and extra fields or surrounding whitespace', () => {
  const fields = legacyHash.split('$')
  const invalid = [
    '', 'scrypt', fields.slice(0, 5).join('$'), [...fields.slice(0, 5), ''].join('$'),
    legacyHash + '$extra', legacyHash + '$', '$' + legacyHash,
    ' ' + legacyHash, legacyHash + ' ', legacyHash + '\n', legacyHash + '\r\n',
    fields.slice(1).join('$'), [...fields.slice(0, 4), '', fields[5]].join('$')
  ]
  for (const stored of invalid) {
    assert.equal(verifyPassword('Test1234!', stored), false)
    assert.equal(verifyPassword('any-other-password', stored), false)
  }
})

test('password verification refuses unsupported or noncanonical algorithms and cost parameters', () => {
  const alternatives = [
    [0, 'SCRYPT'], [0, 'bcrypt'],
    [1, '8192'], [1, '1073741824'], [1, '016384'], [1, '16384.0'], [1, '+16384'], [1, '1e100'], [1, 'NaN'],
    [2, '0'], [2, '16'], [2, '08'], [3, '0'], [3, '2'], [3, '1.0'], [3, 'Infinity']
  ]
  for (const [index, value] of alternatives) {
    const fields = legacyHash.split('$')
    fields[index] = value
    assert.equal(verifyPassword('Test1234!', fields.join('$')), false)
  }
})

test('password verification rejects malformed or noncanonical hex without accepting partial decoding', () => {
  const fields = legacyHash.split('$')
  const alternatives = [
    [4, fields[4].toUpperCase()], [5, fields[5].toUpperCase()],
    [4, 'z'.repeat(32)], [5, 'g'.repeat(64)],
    [4, fields[4].slice(0, -1)], [4, fields[4] + '0'],
    [5, fields[5].slice(0, -1)], [5, fields[5] + '0'],
    [5, fields[5].slice(0, -1) + '\0'], [4, fields[4].slice(0, -1) + ' ']
  ]
  for (const [index, value] of alternatives) {
    const changed = [...fields]
    changed[index] = value
    assert.equal(verifyPassword('Test1234!', changed.join('$')), false)
  }
})

test('password verification rejects non-string inputs without invoking their conversion hooks', () => {
  const coercionTrap = { toString() { throw new Error('Conversion must not run') } }
  const values = [undefined, null, false, 7, {}, [], new String('Test1234!'), Buffer.from(legacyHash), coercionTrap, Symbol('test')]
  for (const value of values) {
    assert.equal(verifyPassword(value, legacyHash), false)
    assert.equal(verifyPassword('Test1234!', value), false)
  }
})

test('password generation rejects non-string input with a fixed error', () => {
  for (const value of [undefined, null, 1234, {}, [], new String('password'), Buffer.from('password')]) {
    assert.throws(() => hashPassword(value), { name: 'TypeError', message: 'Password hashing requires a string.' })
  }
})

test('password verification rejects modified salts and digests even when the format remains canonical', () => {
  for (const index of [4, 5]) {
    const fields = legacyHash.split('$')
    fields[index] = (fields[index][0] === '0' ? '1' : '0') + fields[index].slice(1)
    assert.equal(verifyPassword('Test1234!', fields.join('$')), false)
  }
})
