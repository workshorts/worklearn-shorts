import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assertCommentVideoExists } from '../../src/db/comment-queries.js'
import { ApiError } from '../../src/errors.js'
import { withVideoWriteTransaction } from '../../src/services/video-write.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { createDatabaseContext } from '../helpers/database-context.js'

const missing = { code: 'NOT_FOUND', message: '영상을 찾을 수 없습니다.', fields: {} }
const payload = { nickname: 'Author', password: 'private-password', content: 'Comment' }
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('comment-create-video.db')
  context.initialize(path)
  const db = context.open(path)
  db.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(1, 'Target', 'unused-path')
  db.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(2, 'Other', 'unused-other-path')
  return { context, path, db }
}

function snapshot(db, path) {
  return {
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }
}

// Test fixtures exercise the shared write boundary; production insertion is a later plan item.
function insertComment(db, videoId, content = 'Fixture comment') {
  return db.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)')
    .run(videoId, 'Fixture author', 'fixture-only-hash', content)
}

test('a video deleted after comment preflight is rechecked before the shared write callback runs', t => {
  const { context, path, db } = setup(t)
  const writer = context.open(path)
  assertCommentVideoExists(db, 1)
  writer.prepare('DELETE FROM videos WHERE id = ?').run(1)
  const before = snapshot(db, path)
  assert.throws(() => withVideoWriteTransaction(db, 1, () => assert.fail('Deleted parents cannot reach insertion')), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 404)
    assert.deepEqual({ code: error.code, message: error.message, fields: error.fields }, missing)
    return true
  })
  assert.equal(db.isTransaction, false)
  assert.equal(db.isOpen, true)
  assert.deepEqual(snapshot(db, path), before)
})

test('the shared write lock protects comment insertion from another connection deleting its parent', t => {
  for (const mode of ['DELETE', 'WAL']) {
    const { context, path, db } = setup(t)
    assert.equal(db.prepare(`PRAGMA journal_mode = ${mode}`).get().journal_mode, mode.toLowerCase())
    const writer = context.open(path)
    writer.exec('PRAGMA busy_timeout = 0')
    const controlId = insertComment(db, 2, 'Preserved other comment').lastInsertRowid
    const control = db.prepare('SELECT * FROM comments WHERE id = ?').get(controlId)
    const result = withVideoWriteTransaction(db, 1, connection => {
      assert.equal(connection, db)
      assert.equal(connection.isTransaction, true)
      assert.throws(() => writer.prepare('DELETE FROM videos WHERE id = ?').run(1),
        error => error.code === 'ERR_SQLITE_ERROR' && error.errcode === 5)
      return insertComment(connection, 1)
    })
    assert.equal(result.changes, 1)
    assert.equal(db.isTransaction, false)
    assert.equal(db.prepare('SELECT video_id FROM comments WHERE id = ?').get(result.lastInsertRowid).video_id, 1)
    assert.equal(writer.prepare('DELETE FROM videos WHERE id = ?').run(1).changes, 1)
    assert.equal(db.prepare('SELECT * FROM comments WHERE id = ?').get(result.lastInsertRowid), undefined)
    assert.deepEqual(db.prepare('SELECT * FROM comments WHERE id = ?').get(controlId), control)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  }
})

test('unrelated comment constraints remain native errors and roll back earlier writes without becoming a parent 404', t => {
  const { db, path } = setup(t)
  const before = snapshot(db, path)
  for (const [videoId, content, errcode] of [[999, 'Missing foreign key', 787], [1, '', 275]]) {
    assert.throws(() => withVideoWriteTransaction(db, 1, connection => {
      insertComment(connection, 1)
      insertComment(connection, videoId, content)
    }), error => !(error instanceof ApiError) && error.code === 'ERR_SQLITE_ERROR' && error.errcode === errcode)
    assert.equal(db.isTransaction, false)
    assert.deepEqual(snapshot(db, path), before)
  }
  assert.equal(withVideoWriteTransaction(db, 1, connection => insertComment(connection, 1)).changes, 1)
})

test('registered comment POST checks its parent after validation and quota and handles lookup failures safely', { timeout: 30000 }, async t => {
  const settings = { COMMENT_CREATE_MAX: '3', COMMENT_CREATE_WINDOW_SECONDS: '2' }
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]))
  Object.assign(process.env, settings)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const { requireCommentVideo } = await import('../../src/middleware/requireCommentVideo.js')
  const db = getDb()
  for (const id of [1, 2, Number.MAX_SAFE_INTEGER]) {
    db.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(id, 'Parent', 'invalid-media-path')
  }
  insertComment(db, 1)
  const baseline = snapshot(db, databasePath)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const post = (id, options = {}) => request(`/api/videos/${id}/comments`, { method: 'POST', body: payload, ...options })

  await t.test('existing empty, populated and maximum-ID parents pass without media, visitor or authentication requirements', () => {
    for (const id of [1, 2, Number.MAX_SAFE_INTEGER]) {
      const input = { id, ...payload }
      const res = { locals: { commentCreateRequest: input, existing: 'preserved' } }
      let calls = 0
      requireCommentVideo({}, res, () => { calls += 1 })
      assert.equal(calls, 1)
      assert.deepEqual(res.locals, { commentCreateRequest: input, existing: 'preserved' })
    }
    assert.deepEqual(snapshot(db, databasePath), baseline)
  })

  await t.test('missing parents return the video-specific 404 and still consume quota while invalid input does not', async subtest => {
    assert.equal((await post(0)).status, 400)
    assert.equal((await post(3, { body: {} })).status, 400)
    for (const id of [3, Number.MAX_SAFE_INTEGER - 1, 3]) {
      const response = await post(id)
      assert.equal(response.status, 404)
      assert.deepEqual(response.json, missing)
      assert.equal(response.headers['set-cookie'], undefined)
      assert.equal(response.headers['retry-after'], undefined)
    }
    const prepared = subtest.mock.method(db, 'prepare', () => assert.fail('Quota must stop before parent lookup'))
    try {
      const blocked = await post(3)
      assert.equal(blocked.status, 429)
      assert.equal(blocked.headers['retry-after'], '2')
      assert.equal(prepared.mock.callCount(), 0)
    } finally {
      prepared.mock.restore()
    }
    assert.deepEqual(snapshot(db, databasePath), baseline)
  })

  await t.test('a parent deleted after a successful preflight returns 404 on the next real request', async () => {
    now += 2000
    requireCommentVideo({}, { locals: { commentCreateRequest: { id: 2 } } }, () => {})
    db.prepare('DELETE FROM videos WHERE id = ?').run(2)
    const before = snapshot(db, databasePath)
    const response = await post(2)
    assert.equal(response.status, 404)
    assert.deepEqual(response.json, missing)
    assert.deepEqual(snapshot(db, databasePath), before)
  })

  await t.test('database lookup failure returns a fixed 500 and leaves the connection usable after recovery', async subtest => {
    now += 2000
    const before = snapshot(db, databasePath)
    const log = subtest.mock.method(console, 'error', () => {})
    const fault = subtest.mock.method(db, 'prepare', () => { throw new Error('private-database-password-hash') })
    try {
      const response = await post(1)
      assert.equal(response.status, 500)
      assert.deepEqual(response.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
      assert.equal(response.headers['set-cookie'], undefined)
      assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
    } finally {
      fault.mock.restore()
      log.mock.restore()
    }
    let calls = 0
    requireCommentVideo({}, { locals: { commentCreateRequest: { id: 1 } } }, () => { calls += 1 })
    assert.equal(calls, 1)
    assert.equal(db.isOpen, true)
    assert.equal(db.isTransaction, false)
    assert.deepEqual(snapshot(db, databasePath), before)
  })
})
