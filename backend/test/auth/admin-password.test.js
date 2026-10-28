import assert from 'node:assert/strict'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'

test('administrator login rejects damaged hashes without issuing a cookie or changing the account', { timeout: 15000 }, async t => {
  const { admin, getDb, login } = await startAuthServer(t)
  const database = getDb()
  const legacyHash = 'scrypt$16384$8$1$000102030405060708090a0b0c0d0e0f$d58dbea90e304368cc65b6c23c2c7d39ca8a42cb6ab8db560fc328337184534e'
  const fields = legacyHash.split('$')
  const invalidHashes = [
    [...fields.slice(0, 5), ''].join('$'), legacyHash + '$extra', 'scrypt',
    [...fields.slice(0, 5), fields[5].slice(0, -2)].join('$'),
    'scrypt$1073741824$8$1$' + fields[4] + '$' + fields[5],
    [...fields.slice(0, 5), 'g'.repeat(64)].join('$')
  ]
  const update = database.prepare('UPDATE admins SET password_hash = ? WHERE username = ?')
  const read = database.prepare('SELECT * FROM admins WHERE username = ?')

  for (const stored of invalidHashes) {
    update.run(stored, admin.username)
    const before = read.get(admin.username)
    const { res } = await login()
    assert.equal(res.status, 401)
    assert.equal(res.json.code, 'INVALID_CREDENTIALS')
    assert.deepEqual(res.json.fields, {})
    assert.equal(res.headers['set-cookie'], undefined)
    assert.equal(res.text.includes(admin.password), false)
    assert.equal(res.text.includes(stored), false)
    assert.deepEqual(read.get(admin.username), before)
  }

  update.run(legacyHash, admin.username)
  const before = read.get(admin.username)
  assert.equal((await login('wrong-password')).res.status, 401)
  assert.equal((await login()).res.status, 200)
  assert.deepEqual(read.get(admin.username), before)
})
