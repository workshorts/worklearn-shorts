import assert from 'node:assert/strict'
import crypto, { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import test from 'node:test'
import { hashPassword } from '../../src/lib/password.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const payload = { password: '1234' }
const rateError = { code: 'RATE_LIMITED', message: '시도가 너무 많습니다. 잠시 후 다시 시도하세요.', fields: {} }
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('comment deletion consumes an independent shared IP quota after validation and before password work', { timeout: 30000 }, async t => {
  const settings = { COMMENT_DELETE_MAX: '3', COMMENT_DELETE_WINDOW_SECONDS: '2',
    COMMENT_CREATE_MAX: '1', COMMENT_CREATE_WINDOW_SECONDS: '2' }
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]))
  Object.assign(process.env, settings)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const timers = []
  const interval = globalThis.setInterval
  const capture = t.mock.method(globalThis, 'setInterval', (...args) => {
    const timer = interval(...args)
    timers.push(timer)
    return timer
  })
  t.after(() => timers.forEach(timer => clearInterval(timer)))
  const { request, login, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  capture.mock.restore()
  const { limitCommentCreateRequest, limitCommentDeleteRequest } = await import('../../src/middleware/commentRequestLimits.js')
  const db = getDb()
  const fixture = insertMinimalFixture(db)
  db.prepare('UPDATE comments SET password_hash = ? WHERE id = ?').run(hashPassword(payload.password), fixture.commentId)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const remove = (id = fixture.commentId, options = {}) => request(`/api/comments/${id}`, {
    method: 'DELETE', body: payload, ...options,
  })
  const create = () => request(`/api/videos/${fixture.videoId}/comments`, {
    method: 'POST', body: { ...payload, nickname: 'Author', content: 'Independent creation' },
  })
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  function blocked(response, seconds = 2) {
    assert.equal(response.status, 429)
    assert.deepEqual(response.json, rateError)
    assert.equal(response.headers['retry-after'], String(seconds))
    assert.equal(response.headers['set-cookie'], undefined)
    assert.match(response.headers['content-type'], /^application\/json\b/)
  }
  function admitted(response) {
    // The quota admits an attempt; target lookup, password checks and deletion are later handlers.
    assert.ok([204, 403, 404].includes(response.status))
    assert.equal(response.headers['retry-after'], undefined)
  }

  await t.test('invalid input consumes no quota and IDs, passwords, cookies and forged forwarded addresses share one bucket', async () => {
    assert.equal((await remove('0')).status, 400)
    assert.equal((await remove(fixture.commentId, { body: {} })).status, 400)
    assert.equal((await remove(fixture.commentId, { body: '{bad' })).status, 400)
    assert.equal((await remove(fixture.commentId, { headers: { 'Content-Type': 'text/plain' } })).status, 415)
    admitted(await remove())
    admitted(await remove(Number.MAX_SAFE_INTEGER, { headers: { 'X-Forwarded-For': '192.0.2.1' } }))
    admitted(await remove(fixture.commentId, { body: { password: 'different-password', visitorId: 'different' },
      headers: { 'X-Forwarded-For': '192.0.2.2', 'X-Visitor-Id': 'different' }, cookie: 'visitor=different' }))
    blocked(await remove(Number.MAX_SAFE_INTEGER, { headers: { 'X-Forwarded-For': '192.0.2.3' } }))
  })

  await t.test('blocked attempts perform no SQL, scrypt or logging and retain validation priority and the original expiry', async subtest => {
    const before = snapshot()
    const prepared = subtest.mock.method(db, 'prepare', () => assert.fail('Blocked attempts must not query the target'))
    const executed = subtest.mock.method(db, 'exec', () => assert.fail('Blocked attempts must not open a transaction'))
    const derived = subtest.mock.method(crypto, 'scryptSync', () => assert.fail('Blocked attempts must not verify a password'))
    syncBuiltinESMExports()
    const log = subtest.mock.method(console, 'error', () => {})
    try {
      blocked(await remove())
      assert.equal((await remove('0')).status, 400)
      assert.equal((await remove(fixture.commentId, { body: {} })).status, 400)
      assert.equal((await remove(fixture.commentId, { body: '{bad' })).status, 400)
      assert.equal((await remove(fixture.commentId, { headers: { 'Content-Type': 'text/plain' } })).status, 415)
      now += 1500
      blocked(await remove(), 1)
      now += 499
      blocked(await remove(), 1)
      assert.equal(prepared.mock.callCount(), 0)
      assert.equal(executed.mock.callCount(), 0)
      assert.equal(derived.mock.callCount(), 0)
      assert.equal(log.mock.callCount(), 0)
    } finally {
      prepared.mock.restore()
      executed.mock.restore()
      derived.mock.restore()
      syncBuiltinESMExports()
      log.mock.restore()
    }
    assert.deepEqual(snapshot(), before)
    assert.equal(db.isTransaction, false)
    now += 1
    for (let index = 0; index < 3; index++) admitted(await remove())
    blocked(await remove())
  })

  await t.test('a concurrent deletion burst admits exactly the configured attempt count across comment IDs', async () => {
    now += 2000
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      remove(index % 2 === 0 ? fixture.commentId : Number.MAX_SAFE_INTEGER)))
    const allowed = results.filter(response => response.status !== 429)
    assert.equal(allowed.length, 3)
    allowed.forEach(admitted)
    const denied = results.filter(response => response.status === 429)
    assert.equal(denied.length, 17)
    denied.forEach(response => blocked(response))
  })

  await t.test('creation, public reads and login remain independent and successful login cannot reset the deletion quota', async () => {
    assert.equal((await create()).status, 201)
    blocked(await create())
    assert.equal((await request(`/api/videos/${fixture.videoId}/comments`)).status, 200)
    assert.equal((await login('Wrong-password')).res.status, 401)
    const session = await login()
    assert.equal(session.res.status, 200)
    blocked(await remove(fixture.commentId, { cookie: session.cookie }))
    now += 2000
    admitted(await remove())
    assert.equal((await create()).status, 201)
    blocked(await create())
    admitted(await remove())
    admitted(await remove())
    blocked(await remove())
  })

  await t.test('the middleware uses only Express IP and preserves context while creation and other IPs keep separate quotas', () => {
    const input = Object.freeze({ id: 1, ...payload })
    const res = { locals: { commentDeleteRequest: input } }
    const req = { ip: '192.0.2.20', get headers() { assert.fail('Forwarded identity headers must not be read') } }
    let calls = 0
    for (let index = 0; index < 3; index++) limitCommentDeleteRequest(req, res, () => { calls += 1 })
    assert.throws(() => limitCommentDeleteRequest(req, res, () => { calls += 1 }), error => error.status === 429)
    assert.equal(calls, 3)
    assert.equal(res.locals.commentDeleteRequest, input)
    limitCommentCreateRequest(req, res, () => { calls += 1 })
    assert.equal(calls, 4)
    for (const ip of ['192.0.2.21', '2001:db8::1']) limitCommentDeleteRequest({ ip }, res, () => { calls += 1 })
    assert.equal(calls, 6)
  })

  await t.test('downstream password failures and internal failures do not refund attempts or reset quota on success', () => {
    const req = { ip: '192.0.2.30' }
    for (const status of [403, 500]) {
      const failure = Object.assign(new Error('Downstream failure'), { status })
      assert.throws(() => limitCommentDeleteRequest(req, {}, () => { throw failure }), error => error === failure)
    }
    let calls = 0
    limitCommentDeleteRequest(req, {}, () => { calls += 1 })
    assert.throws(() => limitCommentDeleteRequest(req, {}, () => { calls += 1 }),
      error => error.status === 429 && error.headers['Retry-After'] === '2')
    assert.equal(calls, 1)
  })
})
