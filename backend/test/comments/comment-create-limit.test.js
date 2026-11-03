import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'

const payload = { nickname: 'Author', password: 'private-password', content: 'Comment' }
const rateError = { code: 'RATE_LIMITED', message: '시도가 너무 많습니다. 잠시 후 다시 시도하세요.', fields: {} }
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('comment creation enforces shared IP quotas after validation and before downstream work', { timeout: 30000 }, async t => {
  const settings = { COMMENT_CREATE_MAX: '3', COMMENT_CREATE_WINDOW_SECONDS: '2' }
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
  const captureTimers = t.mock.method(globalThis, 'setInterval', (...args) => {
    const timer = interval(...args)
    timers.push(timer)
    return timer
  })
  t.after(() => timers.forEach(timer => clearInterval(timer)))
  const { request, login, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  captureTimers.mock.restore()
  const { limitCommentCreateRequest } = await import('../../src/middleware/commentRequestLimits.js')
  const db = getDb()
  const id = db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Rate limited parent', 'unused-path').lastInsertRowid
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const post = (videoId = id, options = {}) => request(`/api/videos/${videoId}/comments`, {
    method: 'POST', body: payload, ...options,
  })
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  function expectBlocked(response, seconds) {
    assert.equal(response.status, 429)
    assert.deepEqual(response.json, rateError)
    assert.equal(response.headers['retry-after'], String(seconds))
    assert.equal(response.headers['set-cookie'], undefined)
    assert.match(response.headers['content-type'], /^application\/json\b/)
  }
  function expectAdmitted(response) {
    // Persistence is connected in later plan items; here the request must pass the quota.
    assert.ok(response.status === 404 || response.status === 201)
    assert.equal(response.headers['retry-after'], undefined)
  }

  await t.test('invalid JSON, media types, IDs and fields consume no quota and forged identities cannot bypass it', async () => {
    for (const options of [{ body: '{bad' }, { body: {} },
      { headers: { 'Content-Type': 'text/plain' } }]) {
      const response = await post(id, options)
      assert.ok(response.status === 400 || response.status === 415)
    }
    assert.equal((await post('0')).status, 400)
    expectAdmitted(await post())
    expectAdmitted(await post(Number.MAX_SAFE_INTEGER, { headers: { 'X-Forwarded-For': '192.0.2.1' } }))
    expectAdmitted(await post(id, { body: { ...payload, nickname: 'Other', visitorId: 'other' },
      headers: { 'X-Forwarded-For': '192.0.2.2', 'X-Visitor-Id': 'other' }, cookie: 'visitor=other' }))
    expectBlocked(await post(Number.MAX_SAFE_INTEGER, { headers: { 'X-Forwarded-For': '192.0.2.3' } }), 2)
  })

  await t.test('blocked requests do no SQL or logging, invalid input keeps priority and retries do not extend the window', async subtest => {
    const before = snapshot()
    const prepared = subtest.mock.method(db, 'prepare', () => assert.fail('Blocked requests must not query storage'))
    const executed = subtest.mock.method(db, 'exec', () => assert.fail('Blocked requests must not start a transaction'))
    const log = subtest.mock.method(console, 'error', () => {})
    try {
      expectBlocked(await post(), 2)
      assert.equal((await post(id, { body: {} })).status, 400)
      assert.equal((await post('0')).status, 400)
      assert.equal((await post(id, { body: '{bad' })).status, 400)
      assert.equal((await post(id, { headers: { 'Content-Type': 'text/plain' } })).status, 415)
      now += 1500
      expectBlocked(await post(), 1)
      now += 499
      expectBlocked(await post(), 1)
      assert.equal(prepared.mock.callCount(), 0)
      assert.equal(executed.mock.callCount(), 0)
      assert.equal(log.mock.callCount(), 0)
    } finally {
      prepared.mock.restore()
      executed.mock.restore()
      log.mock.restore()
    }
    assert.deepEqual(snapshot(), before)
    assert.equal(db.isTransaction, false)
    now += 1
    for (let index = 0; index < 3; index++) expectAdmitted(await post())
    expectBlocked(await post(), 2)
  })

  await t.test('a concurrent HTTP burst admits exactly the configured number of attempts', async () => {
    now += 2000
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      post(index % 2 === 0 ? id : Number.MAX_SAFE_INTEGER)))
    const admitted = responses.filter(response => response.status !== 429)
    assert.equal(admitted.length, 3)
    admitted.forEach(expectAdmitted)
    const blocked = responses.filter(response => response.status === 429)
    assert.equal(blocked.length, 9)
    blocked.forEach(response => expectBlocked(response, 2))
  })

  await t.test('public GET and administrator login keep their own behavior and login success does not reset comment quota', async () => {
    const comments = await request(`/api/videos/${id}/comments`)
    assert.equal(comments.status, 200)
    assert.equal(comments.headers['retry-after'], undefined)
    const rejectedLogin = await login('Wrong-password')
    assert.equal(rejectedLogin.res.status, 401)
    const acceptedLogin = await login()
    assert.equal(acceptedLogin.res.status, 200)
    assert.ok(acceptedLogin.cookie)
    expectBlocked(await post(id, { cookie: acceptedLogin.cookie }), 2)
  })

  await t.test('the middleware reads only Express IP, preserves context and blocks before the continuation', () => {
    const input = { id: 1, ...payload }
    const res = { locals: { commentCreateRequest: input } }
    const req = { ip: '192.0.2.20', get headers() { assert.fail('Do not read client-supplied identity headers') } }
    let calls = 0
    for (let index = 0; index < 3; index++) limitCommentCreateRequest(req, res, () => { calls += 1 })
    assert.throws(() => limitCommentCreateRequest(req, res, () => { calls += 1 }),
      error => error.status === 429 && error.code === 'RATE_LIMITED')
    assert.equal(calls, 3)
    assert.equal(res.locals.commentCreateRequest, input)
    for (const ip of ['192.0.2.21', '2001:db8::1']) {
      limitCommentCreateRequest({ ip }, res, () => { calls += 1 })
    }
    assert.equal(calls, 5)
  })

  await t.test('downstream failures and success retain consumed attempts rather than resetting the quota', () => {
    const req = { ip: '192.0.2.30' }
    for (const status of [404, 500]) {
      const failure = Object.assign(new Error('Downstream failure'), { status })
      assert.throws(() => limitCommentCreateRequest(req, {}, () => { throw failure }), error => error === failure)
    }
    let calls = 0
    limitCommentCreateRequest(req, {}, () => { calls += 1 })
    assert.throws(() => limitCommentCreateRequest(req, {}, () => { calls += 1 }),
      error => error.status === 429 && error.headers['Retry-After'] === '2')
    assert.equal(calls, 1)
  })
})
