import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assertCommentVideoExists, countVideoComments, loadCommentPage } from '../../src/db/comment-queries.js'
import { withTransaction } from '../../src/db/transaction.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('comment-total.db')
  context.initialize(path)
  return { context, path, database: context.open(path) }
}

function addComment(database, videoId) {
  return database.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)')
    .run(videoId, 'Same author', 'private-test-hash', 'Same content').lastInsertRowid
}

function snapshot(database, path) {
  return {
    rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }
}

test('totals count every matching row independently of other videos, duplicate text, page sizes and sparse IDs', t => {
  const { database } = setup(t)
  assert.equal(countVideoComments(database, 1), 0)
  const fixture = insertMinimalFixture(database)
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(2, 'Other parent', 'unused-path')
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(3, 'Empty parent', 'unused-path')
  for (let index = 0; index < 52; index++) addComment(database, fixture.videoId)
  for (let index = 0; index < 4; index++) addComment(database, 2)
  for (const [page, limit, length] of [[1, 1, 1], [1, 20, 20], [3, 20, 13], [1, 50, 50], [2, 50, 3],
    [4, 20, 0], [Number.MAX_SAFE_INTEGER, 50, 0]]) {
    const result = withTransaction(database, connection => ({
      total: countVideoComments(connection, fixture.videoId),
      rows: loadCommentPage(connection, { videoId: fixture.videoId, page, limit }),
    }), { mode: 'DEFERRED' })
    assert.equal(result.total, 53)
    assert.equal(result.rows.length, length)
  }
  assert.equal(countVideoComments(database, 2), 4)
  assert.equal(countVideoComments(database, 3), 0)
  assert.equal(countVideoComments(database, Number.MAX_SAFE_INTEGER), 0)
  database.prepare('INSERT INTO comments (id, video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?, ?)')
    .run(Number.MAX_SAFE_INTEGER, fixture.videoId, 'Boundary author', 'private-test-hash', 'Boundary row')
  assert.equal(countVideoComments(database, fixture.videoId), 54)
  database.prepare('UPDATE comments SET content = ? WHERE id = ?').run('Edited without changing the count', fixture.commentId)
  assert.equal(countVideoComments(database, fixture.videoId), 54)
  database.prepare('DELETE FROM comments WHERE video_id = ?').run(fixture.videoId)
  assert.equal(countVideoComments(database, fixture.videoId), 0)
  assert.equal(countVideoComments(database, 2), 4)
})

test('the aggregate binds maximum safe video IDs and never reads password or content columns', t => {
  const { database } = setup(t)
  const videoId = Number.MAX_SAFE_INTEGER
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(videoId, 'Boundary parent', 'unused-path')
  addComment(database, videoId)
  addComment(database, videoId)
  const calls = []
  const prepare = database.prepare.bind(database)
  t.mock.method(database, 'prepare', sql => {
    const statement = prepare(sql)
    const get = statement.get.bind(statement)
    t.mock.method(statement, 'get', (...params) => { calls.push({ sql, params }); return get(...params) })
    return statement
  })
  assert.equal(countVideoComments(database, videoId), 2)
  assert.equal(countVideoComments(database, videoId - 1), 0)
  assert.deepEqual(calls.map(call => call.params), [[videoId], [videoId - 1]])
  for (const { sql } of calls) {
    assert.equal(sql.includes(String(videoId)), false)
    assert.doesNotMatch(sql, /password_hash|nickname|content|created_at|LIMIT|OFFSET/i)
  }
})

test('count and page membership keep one read snapshot when another connection commits comment changes', t => {
  const { database, context, path } = setup(t)
  const fixture = insertMinimalFixture(database)
  addComment(database, fixture.videoId)
  assert.equal(database.prepare('PRAGMA journal_mode = WAL').get().journal_mode, 'wal')
  const writer = context.open(path)
  database.exec('PRAGMA query_only = ON')
  withTransaction(database, connection => {
    assertCommentVideoExists(connection, fixture.videoId)
    const total = countVideoComments(connection, fixture.videoId)
    const before = loadCommentPage(connection, { videoId: fixture.videoId, page: 1, limit: 50 })
    assert.equal(total, 2)
    withTransaction(writer, writeConnection => {
      writeConnection.prepare('DELETE FROM comments WHERE id = ?').run(fixture.commentId)
      addComment(writeConnection, fixture.videoId)
      addComment(writeConnection, fixture.videoId)
    })
    assert.equal(countVideoComments(writer, fixture.videoId), 3)
    assert.equal(countVideoComments(connection, fixture.videoId), total)
    assert.deepEqual(loadCommentPage(connection, { videoId: fixture.videoId, page: 1, limit: 50 }), before)
    assert.equal(connection.isTransaction, true)
  }, { mode: 'DEFERRED' })
  assert.equal(countVideoComments(database, fixture.videoId), 3)
  assert.equal(loadCommentPage(database, { videoId: fixture.videoId, page: 1, limit: 50 }).length, 3)
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('counting is read-only and leaves connection and transaction ownership with the caller', t => {
  const { database, path } = setup(t)
  const fixture = insertMinimalFixture(database)
  database.exec('PRAGMA query_only = ON')
  const before = snapshot(database, path)
  const commands = []
  const exec = database.exec.bind(database)
  const observed = t.mock.method(database, 'exec', sql => { commands.push(sql); return exec(sql) })
  try {
    assert.equal(countVideoComments(database, fixture.videoId), 1)
    assert.deepEqual(commands, [])
    withTransaction(database, connection => {
      assert.equal(countVideoComments(connection, fixture.videoId), 1)
      assert.equal(countVideoComments(connection, Number.MAX_SAFE_INTEGER), 0)
      assert.equal(connection.isTransaction, true)
      assert.equal(connection.isOpen, true)
    }, { mode: 'DEFERRED' })
    assert.deepEqual(commands, ['BEGIN', 'COMMIT'])
  } finally {
    observed.mock.restore()
  }
  assert.deepEqual(snapshot(database, path), before)
})

test('database failures propagate instead of returning zero and a caller transaction rolls back before recovery', t => {
  const { database, path } = setup(t)
  const fixture = insertMinimalFixture(database)
  const before = snapshot(database, path)
  let failure
  try { database.prepare('SELECT id FROM unavailable_comment_total_test_table') } catch (error) { failure = error }
  assert.equal(failure?.code, 'ERR_SQLITE_ERROR')
  const fault = t.mock.method(database, 'prepare', () => { throw failure })
  try {
    assert.throws(() => withTransaction(database, connection => countVideoComments(connection, fixture.videoId),
      { mode: 'DEFERRED' }), error => error === failure)
  } finally {
    fault.mock.restore()
  }
  assert.equal(database.isTransaction, false)
  assert.equal(database.isOpen, true)
  assert.equal(countVideoComments(database, fixture.videoId), 1)
  assert.deepEqual(snapshot(database, path), before)
})
