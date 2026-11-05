import assert from 'node:assert/strict'
import crypto, { createHash, scryptSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import test from 'node:test'
import { isSupportedPasswordHash, verifyPassword } from '../../src/lib/password.js'
import { hashCommentPassword } from '../../src/middleware/hashCommentPassword.js'
import { startAuthServer } from '../helpers/auth-server.js'

const payload = { nickname: 'Author', password: '  e\u0301 Mixed  ', content: 'Comment' }
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function prepare(password) {
  const input = Object.freeze({ id: Number.MAX_SAFE_INTEGER, nickname: ' Author ', password, content: ' First\nSecond ',
    get passwordHash() { assert.fail('Untrusted precomputed hashes must not be read') },
    get extra() { assert.fail('Unrelated input must not be read') } })
  const req = Object.freeze({ body: input })
  const res = { locals: { commentCreateRequest: input, existing: 'preserved' } }
  let calls = 0
  hashCommentPassword(req, res, () => { calls += 1 })
  assert.equal(calls, 1)
  assert.equal(res.locals.existing, 'preserved')
  assert.equal(req.body, input)
  assert.equal(input.password, password)
  const candidate = res.locals.commentCreateRequest
  assert.notEqual(candidate, input)
  assert.deepEqual(Object.keys(candidate), ['id', 'nickname', 'passwordHash', 'content'])
  assert.equal(candidate.id, Number.MAX_SAFE_INTEGER)
  assert.equal(candidate.nickname, ' Author ')
  assert.equal(candidate.content, ' First\nSecond ')
  assert.equal(Object.hasOwn(candidate, 'password'), false)
  assert.equal(isSupportedPasswordHash(candidate.passwordHash), true)
  return candidate
}

test('comment hashing accepts validated boundaries and preserves exact spaces, case and Unicode for later verification', () => {
  for (const password of ['1234', 'x'.repeat(30), '😀'.repeat(30), '    ', payload.password]) {
    const candidate = prepare(password)
    assert.equal(verifyPassword(password, candidate.passwordHash), true)
    assert.equal(verifyPassword(password + 'x', candidate.passwordHash), false)
    if (password === payload.password) {
      for (const changed of [password.trim(), password.toLowerCase(), password.normalize('NFC')]) {
        assert.equal(verifyPassword(changed, candidate.passwordHash), false)
      }
    }
  }
})

test('repeated comment passwords receive independent random salts using the shared canonical native scrypt format', () => {
  const first = prepare('1234')
  const second = prepare('1234')
  const [, n, r, p, salt, digest] = first.passwordHash.split('$')
  assert.deepEqual([n, r, p], ['16384', '8', '1'])
  assert.equal(first.passwordHash.length, 114)
  assert.notEqual(salt, second.passwordHash.split('$')[4])
  assert.notEqual(first.passwordHash, second.passwordHash)
  assert.equal(scryptSync('1234', Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }).toString('hex'), digest)
})

test('registered comment POST hashes only admitted existing targets and keeps failures and credentials private', { timeout: 30000 }, async t => {
  const settings = { COMMENT_CREATE_MAX: '2', COMMENT_CREATE_WINDOW_SECONDS: '2' }
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]))
  Object.assign(process.env, settings)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const db = getDb()
  const id = db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)').run('Hash target', 'unused-path').lastInsertRowid
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  const before = snapshot()
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const post = (videoId = id, options = {}) => request(`/api/videos/${videoId}/comments`, { method: 'POST', body: payload, ...options })
  const nativeScrypt = crypto.scryptSync
  const derivations = []
  // Synchronize only this isolated test process's builtin ESM binding and restore it explicitly.
  function mockDerivation(subtest, implementation) {
    const mock = subtest.mock.method(crypto, 'scryptSync', implementation)
    syncBuiltinESMExports()
    return () => { mock.mock.restore(); syncBuiltinESMExports() }
  }
  const restore = mockDerivation(t, (...args) => {
    assert.equal(db.isTransaction, false, 'Password derivation must run outside the write transaction')
    derivations.push(args)
    return nativeScrypt(...args)
  })
  t.after(restore)
  const log = t.mock.method(console, 'error', () => {})

  await t.test('malformed, unsupported, invalid and missing-parent requests never start password derivation', async () => {
    assert.equal((await post(id, { body: '{bad' })).status, 400)
    assert.equal((await post(id, { headers: { 'Content-Type': 'text/plain' } })).status, 415)
    assert.equal((await post('0')).status, 400)
    assert.equal((await post(id, { body: { ...payload, password: '123' } })).status, 400)
    const missing = await post(Number.MAX_SAFE_INTEGER)
    assert.equal(missing.status, 404)
    assert.equal(missing.json.message, '영상을 찾을 수 없습니다.')
    assert.equal(derivations.length, 0)
    assert.deepEqual(snapshot(), before)
  })

  await t.test('an admitted parent derives once without a transaction and sends neither password nor hash to the client', async () => {
    const response = await post()
    assert.equal(response.status, 201)
    assert.equal(derivations.length, 1)
    const [password, salt, length, options] = derivations[0]
    assert.equal(password, payload.password)
    assert.equal(salt.length, 16)
    assert.equal(length, 32)
    assert.deepEqual(options, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 })
    assert.equal(response.text.includes(payload.password), false)
    assert.doesNotMatch(response.text, /scrypt\$|passwordHash|password_hash|"password"/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.equal(log.mock.callCount(), 0)
  })

  await t.test('quota rejection prevents further derivation and invalid input still keeps its validation error', async () => {
    const saved = snapshot()
    const blocked = await post()
    assert.equal(blocked.status, 429)
    assert.equal(blocked.headers['retry-after'], '2')
    assert.equal((await post(id, { body: {} })).status, 400)
    assert.equal(derivations.length, 1)
    assert.equal(log.mock.callCount(), 0)
    assert.deepEqual(snapshot(), saved)
  })

  await t.test('native hash failure becomes the fixed 500, retains consumed quota and permits recovery after restoration', async subtest => {
    now += 2000
    const saved = snapshot()
    const fault = new Error('private-password-hash-and-native-details')
    const undo = mockDerivation(subtest, () => { throw fault })
    try {
      const response = await post()
      assert.equal(response.status, 500)
      assert.deepEqual(response.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
      assert.equal(response.headers['set-cookie'], undefined)
      assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
      assert.deepEqual(snapshot(), saved)
    } finally {
      undo()
    }
    const recovered = await post()
    assert.equal(recovered.status, 201)
    assert.equal(derivations.length, 2)
    assert.equal((await post()).status, 429)
    assert.equal(derivations.length, 2)
  })
  assert.equal(db.isOpen, true)
  assert.equal(db.isTransaction, false)
  const after = snapshot()
  assert.deepEqual(after.schema, before.schema)
  for (const table of tables.filter(table => table !== 'comments' && table !== 'sqlite_sequence')) {
    assert.deepEqual(after.rows[table], before.rows[table])
  }
  assert.equal(after.rows.comments.length, before.rows.comments.length + 2)
  for (const row of after.rows.comments) assert.equal(verifyPassword(payload.password, row.password_hash), true)
})
