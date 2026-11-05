import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assertCommentVideoExists } from '../../src/db/comment-queries.js'
import { withTransaction } from '../../src/db/transaction.js'
import { ApiError } from '../../src/errors.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('comment-video.db')
  context.initialize(path)
  return { context, path, database: context.open(path) }
}

function snapshot(database, path) {
  return {
    rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }
}

function missing(database, id) {
  assert.throws(() => assertCommentVideoExists(database, id), error => {
    assert.ok(error instanceof ApiError)
    assert.deepEqual({ status: error.status, code: error.code, message: error.message,
      fields: error.fields, headers: error.headers }, {
      status: 404, code: 'NOT_FOUND', message: '영상을 찾을 수 없습니다.', fields: {}, headers: {},
    })
    return true
  })
}

test('missing parents return the video-specific 404 in empty and populated databases without changes', t => {
  const { database, path } = setup(t)
  let before = snapshot(database, path)
  for (const id of [1, Number.MAX_SAFE_INTEGER]) missing(database, id)
  assert.deepEqual(snapshot(database, path), before)
  insertMinimalFixture(database)
  before = snapshot(database, path)
  for (const id of [2, Number.MAX_SAFE_INTEGER]) missing(database, id)
  assert.deepEqual(snapshot(database, path), before)
  assert.equal(database.isOpen, true)
  assert.equal(database.isTransaction, false)
})

test('existing parents pass with or without comments and do not require valid media metadata', t => {
  const { database, path } = setup(t)
  const fixture = insertMinimalFixture(database)
  const empty = database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
  empty.run(2, 'Empty comment parent', 'invalid-internal-media-path')
  empty.run(Number.MAX_SAFE_INTEGER, 'Boundary parent', 'another-invalid-internal-path')
  database.exec('PRAGMA query_only = ON')
  const before = snapshot(database, path)
  for (const id of [fixture.videoId, 2, Number.MAX_SAFE_INTEGER]) assert.equal(assertCommentVideoExists(database, id), undefined)
  assert.deepEqual(snapshot(database, path), before)
  assert.equal(database.isTransaction, false)
})

test('the lookup executes exactly one bound ID-only SELECT and does not control transactions', t => {
  const { database, path } = setup(t)
  const fixture = insertMinimalFixture(database)
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
    .run(Number.MAX_SAFE_INTEGER, 'Boundary parent', 'unused-media-path')
  const before = snapshot(database, path)
  const reads = []
  const prepare = database.prepare.bind(database)
  const prepared = t.mock.method(database, 'prepare', sql => {
    const statement = prepare(sql)
    const get = statement.get.bind(statement)
    t.mock.method(statement, 'get', (...params) => { reads.push({ sql, params }); return get(...params) })
    return statement
  })
  const exec = t.mock.method(database, 'exec', () => assert.fail('Parent lookup must not control transactions'))
  try {
    assertCommentVideoExists(database, fixture.videoId)
    assertCommentVideoExists(database, Number.MAX_SAFE_INTEGER)
    missing(database, Number.MAX_SAFE_INTEGER - 1)
    assert.equal(prepared.mock.callCount(), 3)
    assert.equal(exec.mock.callCount(), 0)
    assert.deepEqual(reads, [fixture.videoId, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1]
      .map(id => ({ sql: 'SELECT id FROM videos WHERE id = ?', params: [id] })))
  } finally {
    prepared.mock.restore()
    exec.mock.restore()
  }
  assert.deepEqual(snapshot(database, path), before)
})

test('native database errors propagate unchanged instead of becoming missing-video errors and allow recovery', t => {
  const { database, path } = setup(t)
  const fixture = insertMinimalFixture(database)
  let failure
  try { database.prepare('SELECT id FROM unavailable_comment_video_test_table') } catch (error) { failure = error }
  assert.equal(failure?.code, 'ERR_SQLITE_ERROR')
  const before = snapshot(database, path)
  const fault = t.mock.method(database, 'prepare', () => { throw failure })
  try {
    assert.throws(() => assertCommentVideoExists(database, fixture.videoId), error => error === failure && !(error instanceof ApiError))
  } finally {
    fault.mock.restore()
  }
  assert.equal(database.isTransaction, false)
  assertCommentVideoExists(database, fixture.videoId)
  assert.deepEqual(snapshot(database, path), before)
})

test('caller-owned read transactions remain open after both successful and missing lookups', t => {
  const { database, path } = setup(t)
  const fixture = insertMinimalFixture(database)
  const before = snapshot(database, path)
  const commands = []
  const exec = database.exec.bind(database)
  const observed = t.mock.method(database, 'exec', sql => { commands.push(sql); return exec(sql) })
  try {
    withTransaction(database, connection => {
      assertCommentVideoExists(connection, fixture.videoId)
      missing(connection, Number.MAX_SAFE_INTEGER)
      assert.equal(connection.isOpen, true)
      assert.equal(connection.isTransaction, true)
    }, { mode: 'DEFERRED' })
    assert.deepEqual(commands, ['BEGIN', 'COMMIT'])
  } finally {
    observed.mock.restore()
  }
  assert.deepEqual(snapshot(database, path), before)
})

test('the supplied read snapshot survives a concurrent parent deletion and a later lookup sees the deletion', t => {
  const { database, context, path } = setup(t)
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(1, 'Snapshot parent', 'unused-path')
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(2, 'Preserved parent', 'unused-other-path')
  assert.equal(database.prepare('PRAGMA journal_mode = WAL').get().journal_mode, 'wal')
  const writer = context.open(path)
  database.exec('PRAGMA query_only = ON')
  const control = database.prepare('SELECT * FROM videos WHERE id = ?').get(2)
  withTransaction(database, connection => {
    assertCommentVideoExists(connection, 1)
    withTransaction(writer, writeConnection => writeConnection.prepare('DELETE FROM videos WHERE id = ?').run(1))
    assertCommentVideoExists(connection, 1)
    assert.equal(connection.isTransaction, true)
  }, { mode: 'DEFERRED' })
  missing(database, 1)
  assertCommentVideoExists(database, 2)
  assert.deepEqual(database.prepare('SELECT * FROM videos WHERE id = ?').get(2), control)
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('a closed connection fails without reopening it and a separately owned connection can read the parent', t => {
  const { database, context, path } = setup(t)
  const fixture = insertMinimalFixture(database)
  const before = snapshot(database, path)
  database.close()
  assert.throws(() => assertCommentVideoExists(database, fixture.videoId), error => !(error instanceof ApiError))
  assert.equal(database.isOpen, false)
  const reopened = context.open(path)
  assertCommentVideoExists(reopened, fixture.videoId)
  assert.deepEqual(snapshot(reopened, path), before)
})
