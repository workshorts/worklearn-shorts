import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadCommentDeleteTarget } from '../../src/db/comment-queries.js'
import { withTransaction } from '../../src/db/transaction.js'
import { ApiError } from '../../src/errors.js'
import { hashPassword } from '../../src/lib/password.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']
const missing = { code: 'NOT_FOUND', message: '댓글을 찾을 수 없습니다.', fields: {} }

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('comment-delete-target.db')
  context.initialize(path)
  const db = context.open(path)
  return { context, path, db, ...insertMinimalFixture(db) }
}

function snapshot(db, path) {
  return {
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }
}

function assertMissing(operation) {
  assert.throws(operation, error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 404)
    assert.deepEqual({ code: error.code, message: error.message, fields: error.fields }, missing)
    assert.deepEqual(error.headers, {})
    return true
  })
}

test('delete lookup returns only the exact internal credentials and missing comments receive the comment-specific 404', t => {
  const { db, path, commentId, videoId } = setup(t)
  db.prepare('INSERT INTO comments (id, video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?, ?)')
    .run(Number.MAX_SAFE_INTEGER, videoId, 'Boundary author', 'malformed-hash-kept-for-later-verification', 'Private text')
  const before = snapshot(db, path)
  assert.deepEqual({ ...loadCommentDeleteTarget(db, commentId) }, { id: commentId, password_hash: 'test-only-placeholder' })
  assert.deepEqual({ ...loadCommentDeleteTarget(db, Number.MAX_SAFE_INTEGER) },
    { id: Number.MAX_SAFE_INTEGER, password_hash: 'malformed-hash-kept-for-later-verification' })
  for (const id of [commentId + 1, Number.MAX_SAFE_INTEGER - 1]) assertMissing(() => loadCommentDeleteTarget(db, id))
  assert.deepEqual(snapshot(db, path), before)
  assert.equal(db.isTransaction, false)
})

test('delete lookup binds one ID and reads two columns without writes or taking connection and transaction ownership', t => {
  const { db, path, commentId } = setup(t)
  db.exec('PRAGMA query_only = ON')
  const before = snapshot(db, path)
  const prepare = db.prepare.bind(db)
  const calls = []
  const observed = t.mock.method(db, 'prepare', sql => {
    const statement = prepare(sql)
    const get = statement.get.bind(statement)
    t.mock.method(statement, 'get', (...args) => { calls.push({ sql, args }); return get(...args) })
    return statement
  })
  const exec = t.mock.method(db, 'exec', () => assert.fail('Lookup must not control a transaction'))
  try {
    const first = loadCommentDeleteTarget(db, commentId)
    const second = loadCommentDeleteTarget(db, commentId)
    assert.notEqual(first, second)
    assert.deepEqual(Object.keys(first), ['id', 'password_hash'])
    assert.deepEqual(calls, Array.from({ length: 2 }, () => ({
      sql: 'SELECT id, password_hash FROM comments WHERE id = ?', args: [commentId],
    })))
    assert.equal(exec.mock.callCount(), 0)
  } finally {
    observed.mock.restore()
    exec.mock.restore()
  }
  assert.equal(db.isOpen, true)
  assert.deepEqual(snapshot(db, path), before)
})

test('native lookup failures remain errors and closed connections are not reopened or mistaken for missing comments', t => {
  const { db, path, context, commentId } = setup(t)
  const before = snapshot(db, path)
  let failure
  try { db.prepare('SELECT id FROM absent_delete_target_test_table') } catch (error) { failure = error }
  const fault = t.mock.method(db, 'prepare', () => { throw failure })
  try {
    assert.throws(() => loadCommentDeleteTarget(db, commentId), error => error === failure && !(error instanceof ApiError))
  } finally {
    fault.mock.restore()
  }
  assert.equal(loadCommentDeleteTarget(db, commentId).id, commentId)
  db.close()
  assert.throws(() => loadCommentDeleteTarget(db, commentId), error => !(error instanceof ApiError))
  assert.equal(db.isOpen, false)
  assert.deepEqual(snapshot(context.open(path), path), before)
})

test('caller-owned read snapshots retain the same target across another connection deleting it and fresh reads see 404', t => {
  const { db, path, context, commentId } = setup(t)
  assert.equal(db.prepare('PRAGMA journal_mode = WAL').get().journal_mode, 'wal')
  const writer = context.open(path)
  db.exec('PRAGMA query_only = ON')
  withTransaction(db, connection => {
    const first = loadCommentDeleteTarget(connection, commentId)
    writer.prepare('DELETE FROM comments WHERE id = ?').run(commentId)
    assert.deepEqual(loadCommentDeleteTarget(connection, commentId), first)
    assert.equal(connection.isTransaction, true)
  }, { mode: 'DEFERRED' })
  assert.equal(db.isTransaction, false)
  assertMissing(() => loadCommentDeleteTarget(db, commentId))
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('registered DELETE looks up credentials after validation and quota without exposing hashes or hiding native errors', { timeout: 30000 }, async t => {
  const previous = { COMMENT_DELETE_MAX: process.env.COMMENT_DELETE_MAX, COMMENT_DELETE_WINDOW_SECONDS: process.env.COMMENT_DELETE_WINDOW_SECONDS }
  Object.assign(process.env, { COMMENT_DELETE_MAX: '3', COMMENT_DELETE_WINDOW_SECONDS: '2' })
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const { requireCommentDeleteTarget } = await import('../../src/middleware/requireCommentDeleteTarget.js')
  const db = getDb()
  const fixture = insertMinimalFixture(db)
  const storedHash = hashPassword('1234')
  db.prepare('UPDATE comments SET password_hash = ? WHERE id = ?').run(storedHash, fixture.commentId)
  db.prepare('INSERT INTO comments (id, video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?, ?)')
    .run(Number.MAX_SAFE_INTEGER, fixture.videoId, 'Boundary author', storedHash, 'Boundary text')
  const baseline = snapshot(db, databasePath)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const remove = (id = fixture.commentId, body = { password: '1234' }) => request(`/api/comments/${id}`, { method: 'DELETE', body })

  await t.test('trusted DB credentials are kept separate from request data and validated inputs remain exact', () => {
    for (const id of [fixture.commentId, Number.MAX_SAFE_INTEGER]) {
      const input = Object.freeze({ id, password: '1234' })
      const res = { locals: { commentDeleteRequest: input, existing: 'preserved' } }
      let calls = 0
      requireCommentDeleteTarget({ get body() { assert.fail('Target credentials must not come from the body') } }, res, () => { calls += 1 })
      assert.equal(calls, 1)
      assert.equal(res.locals.commentDeleteRequest, input)
      assert.equal(res.locals.existing, 'preserved')
      assert.deepEqual({ ...res.locals.commentDeleteTarget }, { id, password_hash: storedHash })
    }
    assert.deepEqual(snapshot(db, databasePath), baseline)
  })

  await t.test('missing comments return a fixed 404 and quota rejection still stops before private SQL', async subtest => {
    assert.equal((await remove(0, {})).status, 400)
    for (const id of [2, 3, Number.MAX_SAFE_INTEGER - 1]) {
      const response = await remove(id)
      assert.equal(response.status, 404)
      assert.deepEqual(response.json, missing)
      assert.equal(response.headers['set-cookie'], undefined)
    }
    const fault = subtest.mock.method(db, 'prepare', () => assert.fail('Quota must stop before private target SQL'))
    try {
      const response = await remove()
      assert.equal(response.status, 429)
      assert.equal(response.headers['retry-after'], '2')
      assert.equal(fault.mock.callCount(), 0)
    } finally {
      fault.mock.restore()
    }
    assert.deepEqual(snapshot(db, databasePath), baseline)
  })

  await t.test('lookup errors remain a fixed 500 with a fixed log and recovery keeps the private target internal', async subtest => {
    now += 2000
    const log = subtest.mock.method(console, 'error', () => {})
    const fault = subtest.mock.method(db, 'prepare', () => {
      throw Object.assign(new Error('private-password-' + storedHash), { status: 404, code: 'NOT_FOUND' })
    })
    try {
      const response = await remove()
      assert.equal(response.status, 500)
      assert.deepEqual(response.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
      assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
    } finally {
      fault.mock.restore()
      log.mock.restore()
    }
    let calls = 0
    requireCommentDeleteTarget({}, { locals: { commentDeleteRequest: { id: fixture.commentId, password: '1234' } } }, () => { calls += 1 })
    assert.equal(calls, 1)
    assert.equal(db.isTransaction, false)
    assert.deepEqual(snapshot(db, databasePath), baseline)
  })

  await t.test('the real route uses the validated ID to read only DB credentials and never sends them to the client', async subtest => {
    now += 2000
    const prepare = db.prepare.bind(db)
    const calls = []
    const observed = subtest.mock.method(db, 'prepare', sql => {
      const statement = prepare(sql)
      const get = statement.get.bind(statement)
      subtest.mock.method(statement, 'get', (...args) => { calls.push({ sql, args }); return get(...args) })
      return statement
    })
    try {
      const response = await remove('000' + fixture.commentId, { password: '1234', password_hash: 'forged-body-hash', id: 999 })
      // Successful password verification reaches the later deletion success handler.
      assert.equal(response.status, 404)
      assert.equal(response.text.includes(storedHash), false)
      assert.doesNotMatch(response.text, /password_hash|commentDeleteTarget|scrypt\$/)
      assert.equal(response.headers['set-cookie'], undefined)
      assert.deepEqual(calls, [{ sql: 'SELECT id, password_hash FROM comments WHERE id = ?', args: [fixture.commentId] }])
    } finally {
      observed.mock.restore()
    }
    assert.deepEqual(snapshot(db, databasePath), baseline)
  })
})
