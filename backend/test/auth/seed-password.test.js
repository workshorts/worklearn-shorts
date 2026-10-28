import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { verifyPassword } from '../../src/lib/password.js'
import { startAuthServer } from '../helpers/auth-server.js'

const entry = fileURLToPath(new URL('../../db/seed.js', import.meta.url))
const legacyHash = 'scrypt$16384$8$1$000102030405060708090a0b0c0d0e0f$d58dbea90e304368cc65b6c23c2c7d39ca8a42cb6ab8db560fc328337184534e'
const tables = ['admins', 'tags', 'videos', 'video_tags', 'courses', 'course_videos',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function snapshot(database) {
  return Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}

function reseed({ databasePath, uploadDir }, username, password) {
  const environment = { ...process.env, DB_PATH: databasePath, UPLOAD_DIR: uploadDir,
    ADMIN_USERNAME: username, ADMIN_PASSWORD: password, NODE_NO_WARNINGS: '1' }
  delete environment.NODE_TEST_CONTEXT
  delete environment.NODE_OPTIONS
  const result = spawnSync(process.execPath, [entry], {
    env: environment, encoding: 'utf8', timeout: 20000, windowsHide: true
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout.trim(), 'Database seeded successfully. Administrator preserved; baseline tags: 7; videos: 8; links: 10.')
  for (const value of [username, password, databasePath, uploadDir, 'scrypt$']) assert.equal(result.stdout.includes(value), false)
}

test('real seed administrator hashes remain compatible with shared verification and HTTP authentication', { timeout: 45000 }, async t => {
  const state = await startAuthServer(t, {
    seed: true, admin: { username: ' Seed Admin ', password: ' Te\u0301st-Seed-Password! ' }
  })
  const { admin, login, request, getDb } = state
  const database = getDb()
  const read = database.prepare('SELECT * FROM admins WHERE username = ?')
  const seeded = read.get(admin.username)
  assert.equal(database.prepare('SELECT count(*) AS count FROM admins').get().count, 1)
  assert.equal(database.prepare('SELECT count(*) AS count FROM videos').get().count, 8)
  const original = snapshot(database)
  const wrongPasswords = ['wrong-test-password', admin.password.trim(), admin.password.toLowerCase(), admin.password.normalize('NFC')]

  await t.test('the persisted seed hash verifies the exact password and rejects modified whitespace, case and Unicode', () => {
    assert.match(seeded.password_hash, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/)
    assert.equal(seeded.password_hash.includes(admin.password), false)
    assert.equal(verifyPassword(admin.password, seeded.password_hash), true)
    for (const password of wrongPasswords) {
      assert.notEqual(password, admin.password)
      assert.equal(verifyPassword(password, seeded.password_hash), false)
    }
    assert.deepEqual(snapshot(database), original)
  })

  await t.test('HTTP login rejects wrong passwords without cookies and accepts the exact seeded credentials and session', async () => {
    for (const password of wrongPasswords) {
      const { res } = await login(password)
      assert.equal(res.status, 401)
      assert.equal(res.json.code, 'INVALID_CREDENTIALS')
      assert.equal(res.headers['set-cookie'], undefined)
      assert.equal(res.text.includes(password), false)
      assert.equal(res.text.includes(seeded.password_hash), false)
    }
    const { res, cookie } = await login()
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { id: seeded.id, username: admin.username })
    assert.match(res.headers['set-cookie'][0], /^admin_session=.*HttpOnly/)
    assert.equal(res.text.includes(admin.password), false)
    assert.equal(res.text.includes(seeded.password_hash), false)
    const me = await request('/api/admin/me', { cookie })
    assert.equal(me.status, 200)
    assert.deepEqual(me.json, { id: seeded.id, username: admin.username })
    assert.deepEqual(snapshot(database), original)
  })

  await t.test('reseeded credentials do not rotate the existing hash or replace the original login password', async () => {
    const replacement = 'new-environment-only-password'
    reseed(state, admin.username, replacement)
    assert.deepEqual(read.get(admin.username), seeded)
    assert.equal(verifyPassword(admin.password, seeded.password_hash), true)
    assert.equal(verifyPassword(replacement, seeded.password_hash), false)
    const rejected = await login(replacement)
    assert.equal(rejected.res.status, 401)
    assert.equal(rejected.res.headers['set-cookie'], undefined)
    assert.equal((await login()).res.status, 200)
    assert.deepEqual(snapshot(database), original)
  })

  await t.test('reseeded legacy administrator hashes keep their original password and remain usable over HTTP', async () => {
    const username = 'legacy-seed-admin'
    const password = 'Test1234!'
    const replacement = 'legacy-environment-only-password'
    database.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)')
      .run(username, legacyHash, '2020-01-02T03:04:05.000Z')
    const before = snapshot(database)
    const legacy = read.get(username)
    reseed(state, username, replacement)
    assert.deepEqual(snapshot(database), before)
    assert.deepEqual(read.get(username), legacy)
    assert.equal(verifyPassword(password, legacy.password_hash), true)
    assert.equal(verifyPassword(replacement, legacy.password_hash), false)
    const denied = await request('/api/admin/login', { method: 'POST', body: { username, password: replacement } })
    assert.equal(denied.status, 401)
    assert.equal(denied.headers['set-cookie'], undefined)
    const allowed = await request('/api/admin/login', { method: 'POST', body: { username, password } })
    assert.equal(allowed.status, 200)
    assert.deepEqual(allowed.json, { id: legacy.id, username })
    assert.equal(allowed.text.includes(legacyHash), false)
    assert.equal(allowed.text.includes(password), false)
    const cookie = allowed.headers['set-cookie'][0].split(';')[0]
    assert.deepEqual((await request('/api/admin/me', { cookie })).json, { id: legacy.id, username })
    assert.deepEqual(snapshot(database), before)
  })
})
