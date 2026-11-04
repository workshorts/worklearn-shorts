import assert from 'node:assert/strict'
import crypto, { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { hashPassword } from '../../src/lib/password.js'
import { verifyCommentDeletePassword } from '../../src/middleware/verifyCommentDeletePassword.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const password = ' e\u0301 MiXeD '
const storedHash = hashPassword(password)
const mismatch = { code: 'COMMENT_PASSWORD_MISMATCH', message: '비밀번호가 일치하지 않습니다.', fields: {} }
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('successful verification preserves input and publishes only trusted ID and hash without plaintext', () => {
  for (const value of ['1234', 'x'.repeat(30), '😀'.repeat(30), '    ', password]) {
    const hash = hashPassword(value)
    const input = Object.freeze({ id: 7, password: value })
    const target = Object.freeze({ id: 7, password_hash: hash })
    const res = { locals: { commentDeleteRequest: input, commentDeleteTarget: target, existing: 'preserved' } }
    let calls = 0
    verifyCommentDeletePassword({ get body() { assert.fail('Only validated input and trusted DB credentials may be used') } }, res,
      () => { calls += 1 })
    assert.equal(calls, 1)
    assert.equal(res.locals.commentDeleteRequest, input)
    assert.equal(res.locals.commentDeleteTarget, target)
    assert.equal(res.locals.existing, 'preserved')
    assert.deepEqual(res.locals.verifiedCommentDeleteTarget, { id: 7, passwordHash: hash })
    assert.equal(Object.hasOwn(res.locals.verifiedCommentDeleteTarget, 'password'), false)
  }
})

test('incorrect exact representations and malformed stored credentials fail closed without publishing verification', () => {
  const attempts = [password.trim(), password.toLowerCase(), password.normalize('NFC'), 'wrong-password']
    .map(value => ({ password: value, hash: storedHash }))
  attempts.push(...[undefined, null, 1234, [], {}, '', 'private-malformed-hash', storedHash + '\n',
    storedHash.replace('16384', '8192')].map(hash => ({ password, hash })))
  for (const attempt of attempts) {
    const res = { locals: { commentDeleteRequest: { id: 7, password: attempt.password },
      commentDeleteTarget: { id: 7, password_hash: attempt.hash } } }
    const before = { ...res.locals }
    assert.throws(() => verifyCommentDeletePassword({}, res, () => assert.fail('Rejected credentials must stop')), error => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 403)
      assert.deepEqual({ code: error.code, message: error.message, fields: error.fields }, mismatch)
      assert.deepEqual(error.headers, {})
      return true
    })
    assert.deepEqual(res.locals, before)
  }
})

test('registered DELETE checks the stored password after validation, quota and lookup without writes or credential leaks', { timeout: 30000 }, async t => {
  const previous = { COMMENT_DELETE_MAX: process.env.COMMENT_DELETE_MAX, COMMENT_DELETE_WINDOW_SECONDS: process.env.COMMENT_DELETE_WINDOW_SECONDS }
  Object.assign(process.env, { COMMENT_DELETE_MAX: '3', COMMENT_DELETE_WINDOW_SECONDS: '2' })
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const db = getDb()
  const fixture = insertMinimalFixture(db)
  db.prepare('UPDATE comments SET password_hash = ? WHERE id = ?').run(storedHash, fixture.commentId)
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const remove = (value = password, id = fixture.commentId, extra = {}) =>
    request(`/api/comments/${id}`, { method: 'DELETE', body: { password: value, ...extra } })
  function rejected(response) {
    assert.equal(response.status, 403)
    assert.deepEqual(response.json, mismatch)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.equal(response.headers['retry-after'], undefined)
    assert.equal(response.text.includes(storedHash), false)
  }

  await t.test('the exact password passes while changed whitespace and Unicode representations return the fixed 403', async subtest => {
    const before = snapshot()
    const log = subtest.mock.method(console, 'error', () => {})
    // Actual deletion and its 204 response are later plan items, so accepted credentials still fall through.
    const accepted = await remove()
    assert.equal(accepted.status, 404)
    assert.equal(accepted.text.includes(storedHash), false)
    rejected(await remove(password.trim()))
    rejected(await remove(password.normalize('NFC')))
    assert.equal(log.mock.callCount(), 0)
    assert.deepEqual(snapshot(), before)
  })

  await t.test('client-supplied hashes and verification markers cannot approve a wrong password', async () => {
    now += 2000
    const before = snapshot()
    const forgedHash = hashPassword('wrong-password')
    rejected(await remove('wrong-password', fixture.commentId, { password_hash: forgedHash, passwordHash: forgedHash,
      verifiedCommentDeleteTarget: { id: fixture.commentId, passwordHash: forgedHash } }))
    assert.deepEqual(snapshot(), before)
  })

  await t.test('malformed stored hashes are denied without native derivation or leaking their values', async subtest => {
    now += 2000
    const derived = subtest.mock.method(crypto, 'scryptSync', () => assert.fail('Malformed credentials must not derive a key'))
    syncBuiltinESMExports()
    try {
      for (const hash of ['', 'private-malformed-hash', storedHash + '\n']) {
        db.prepare('UPDATE comments SET password_hash = ? WHERE id = ?').run(hash, fixture.commentId)
        const before = snapshot()
        rejected(await remove())
        assert.deepEqual(snapshot(), before)
      }
      assert.equal(derived.mock.callCount(), 0)
    } finally {
      derived.mock.restore()
      syncBuiltinESMExports()
      db.prepare('UPDATE comments SET password_hash = ? WHERE id = ?').run(storedHash, fixture.commentId)
    }
  })

  await t.test('validation and missing targets precede derivation and quota blocks before derivation and fixed-size comparison', async subtest => {
    now += 2000
    const before = snapshot()
    const nativeDerive = crypto.scryptSync
    const nativeCompare = crypto.timingSafeEqual
    const derived = subtest.mock.method(crypto, 'scryptSync', (...args) => {
      assert.equal(db.isTransaction, false)
      return nativeDerive(...args)
    })
    const compared = subtest.mock.method(crypto, 'timingSafeEqual', (...args) => {
      assert.deepEqual(args.map(value => value.length), [32, 32])
      return nativeCompare(...args)
    })
    syncBuiltinESMExports()
    try {
      assert.equal((await remove('123')).status, 400)
      assert.equal((await remove(password, 0)).status, 400)
      assert.equal((await request(`/api/comments/${fixture.commentId}`, { method: 'DELETE', body: '{bad' })).status, 400)
      const missing = await remove(password, Number.MAX_SAFE_INTEGER)
      assert.equal(missing.status, 404)
      assert.equal(missing.json.message, '댓글을 찾을 수 없습니다.')
      assert.equal(derived.mock.callCount(), 0)
      assert.equal(compared.mock.callCount(), 0)
      rejected(await remove('wrong-password'))
      assert.equal((await remove()).status, 404)
      assert.equal(derived.mock.callCount(), 2)
      assert.equal(compared.mock.callCount(), 2)
      assert.equal((await remove()).status, 429)
      assert.equal(derived.mock.callCount(), 2)
      assert.equal(compared.mock.callCount(), 2)
    } finally {
      derived.mock.restore()
      compared.mock.restore()
      syncBuiltinESMExports()
    }
    assert.deepEqual(snapshot(), before)
  })

  await t.test('native verification failure fails closed with the same safe 403 and recovers after restoration', async subtest => {
    now += 2000
    const before = snapshot()
    const log = subtest.mock.method(console, 'error', () => {})
    const fault = subtest.mock.method(crypto, 'scryptSync', () => { throw new Error('private-native-details-' + storedHash) })
    syncBuiltinESMExports()
    try {
      rejected(await remove())
      assert.equal(log.mock.callCount(), 0)
    } finally {
      fault.mock.restore()
      syncBuiltinESMExports()
    }
    assert.equal((await remove()).status, 404)
    assert.equal(log.mock.callCount(), 0)
    assert.deepEqual(snapshot(), before)
  })
})
