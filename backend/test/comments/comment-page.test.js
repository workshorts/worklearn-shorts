import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assertCommentVideoExists, loadCommentPage } from '../../src/db/comment-queries.js'
import { withTransaction } from '../../src/db/transaction.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']
const keys = ['id', 'video_id', 'nickname', 'content', 'created_at']
const plain = rows => rows.map(row => ({ ...row }))

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('comment-page.db')
  context.initialize(path)
  const database = context.open(path)
  const fixture = insertMinimalFixture(database)
  const createdAt = '2000-01-01T00:00:00.000Z'
  database.prepare('UPDATE comments SET created_at = ? WHERE id = ?').run(createdAt, fixture.commentId)
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(2, 'Other parent', 'unused-other-path')
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(3, 'Empty parent', 'unused-empty-path')
  return { context, path, database, fixture, initial: { id: fixture.commentId, video_id: fixture.videoId,
    nickname: 'Fixture user', content: 'Fixture comment', created_at: createdAt } }
}

function insert(database, { id = null, videoId = 1, createdAt, nickname = ' 댓글 작성자 ', content = 'Preserved text\nwith whitespace ' }) {
  const result = database.prepare('INSERT INTO comments (id, video_id, nickname, password_hash, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, videoId, nickname, 'private-test-hash-not-for-public-queries', content, createdAt)
  return { id: result.lastInsertRowid, video_id: videoId, nickname, content, created_at: createdAt }
}

function snapshot(database, path) {
  return {
    rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }
}

test('pages filter by video before ordering by newest timestamp and descending sparse IDs at ties', t => {
  const { database, initial } = setup(t)
  const rows = [initial]
  for (const [id, year] of [[5, 2001], [50, 2002], [3, 2003], [90, 2002], [7, 2003], [Number.MAX_SAFE_INTEGER, 2001]]) {
    rows.push(insert(database, { id, createdAt: `${year}-01-01T00:00:00.000Z` }))
  }
  insert(database, { id: 101, videoId: 2, createdAt: '2100-01-01T00:00:00.000Z' })
  const ids = [7, 3, 90, 50, Number.MAX_SAFE_INTEGER, 5, initial.id]
  const expected = ids.map(id => rows.find(row => row.id === id))
  const actual = []
  for (let page = 1; page <= 4; page++) {
    const result = plain(loadCommentPage(database, { videoId: 1, page, limit: 2 }))
    assert.deepEqual(result, expected.slice((page - 1) * 2, page * 2))
    actual.push(...result)
  }
  assert.deepEqual(actual, expected)
  assert.equal(new Set(actual.map(row => row.id)).size, 7)
})

test('minimum, default and maximum page sizes cover every matching row once and empty pages stay empty', t => {
  const { database, initial } = setup(t)
  const rows = [initial]
  for (let index = 1; index <= 52; index++) {
    rows.push(insert(database, { createdAt: `2001-01-${String(index % 5 + 1).padStart(2, '0')}T00:00:00.000Z` }))
  }
  insert(database, { videoId: 2, createdAt: '2100-01-01T00:00:00.000Z' })
  rows.sort((a, b) => a.created_at === b.created_at ? b.id - a.id : a.created_at > b.created_at ? -1 : 1)
  for (const limit of [1, 20, 50]) {
    const actual = []
    for (let page = 1; page <= Math.ceil(rows.length / limit) + 1; page++) {
      const result = plain(loadCommentPage(database, { videoId: 1, page, limit }))
      assert.deepEqual(result, rows.slice((page - 1) * limit, page * limit))
      actual.push(...result)
    }
    assert.deepEqual(actual, rows)
    assert.equal(new Set(actual.map(row => row.id)).size, 53)
  }
  for (const videoId of [3, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(loadCommentPage(database, { videoId, page: 1, limit: 20 }), [])
  }
})

test('the query omits password hashes and binds the maximum video ID with exact large offsets', t => {
  const { database } = setup(t)
  const videoId = Number.MAX_SAFE_INTEGER
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(videoId, 'Boundary parent', 'unused-boundary-path')
  const expected = insert(database, { videoId, createdAt: '2001-01-01T00:00:00.000Z' })
  const calls = []
  const prepare = database.prepare.bind(database)
  const observed = t.mock.method(database, 'prepare', sql => {
    const statement = prepare(sql)
    const all = statement.all.bind(statement)
    t.mock.method(statement, 'all', (...params) => { calls.push({ sql, params }); return all(...params) })
    return statement
  })
  try {
    const rows = loadCommentPage(database, { videoId, page: 1, limit: 1 })
    assert.deepEqual(plain(rows), [expected])
    assert.deepEqual(Object.keys(rows[0]), keys)
    assert.equal(rows[0].password_hash, undefined)
    for (const [page, limit] of [[2, 1], [183820392953900, 49], [Number.MAX_SAFE_INTEGER, 50]]) {
      assert.deepEqual(loadCommentPage(database, { videoId, page, limit }), [])
    }
    assert.equal(observed.mock.callCount(), 4)
    assert.deepEqual(calls.map(call => call.params), [
      [videoId, 1, 0n], [videoId, 1, 1n], [videoId, 49, 9007199254741051n], [videoId, 50, 450359962737049500n],
    ])
    for (const { sql } of calls) {
      assert.doesNotMatch(sql, /password_hash|SELECT\s+\*/i)
      assert.equal(sql.includes(String(videoId)), false)
    }
  } finally {
    observed.mock.restore()
  }
})

test('page reads preserve all rows and file bytes while leaving caller-owned read transactions intact', t => {
  const { database, path, initial } = setup(t)
  database.exec('PRAGMA query_only = ON')
  const before = snapshot(database, path)
  const commands = []
  const exec = database.exec.bind(database)
  const observed = t.mock.method(database, 'exec', sql => { commands.push(sql); return exec(sql) })
  try {
    withTransaction(database, connection => {
      assertCommentVideoExists(connection, 1)
      assert.deepEqual(plain(loadCommentPage(connection, { videoId: 1, page: 1, limit: 20 })), [initial])
      assert.deepEqual(loadCommentPage(connection, { videoId: 1, page: 2, limit: 20 }), [])
      assert.equal(connection.isTransaction, true)
      assert.equal(connection.isOpen, true)
    }, { mode: 'DEFERRED' })
    assert.deepEqual(commands, ['BEGIN', 'COMMIT'])
  } finally {
    observed.mock.restore()
  }
  assert.deepEqual(snapshot(database, path), before)
})

test('parent and page reads share the caller snapshot across another connection changing comments', t => {
  const { database, context, path, initial } = setup(t)
  assert.equal(database.prepare('PRAGMA journal_mode = WAL').get().journal_mode, 'wal')
  const writer = context.open(path)
  database.exec('PRAGMA query_only = ON')
  let replacement
  withTransaction(database, connection => {
    assertCommentVideoExists(connection, 1)
    withTransaction(writer, writeConnection => {
      writeConnection.prepare('DELETE FROM comments WHERE id = ?').run(initial.id)
      replacement = insert(writeConnection, { createdAt: '2100-01-01T00:00:00.000Z' })
    })
    assert.deepEqual(plain(loadCommentPage(connection, { videoId: 1, page: 1, limit: 20 })), [initial])
  }, { mode: 'DEFERRED' })
  assert.deepEqual(plain(loadCommentPage(database, { videoId: 1, page: 1, limit: 20 })), [replacement])
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('native failures propagate instead of becoming empty pages and recovery preserves stored data', t => {
  const { database, context, path, initial } = setup(t)
  const before = snapshot(database, path)
  let failure
  try { database.prepare('SELECT id FROM unavailable_comment_page_test_table') } catch (error) { failure = error }
  assert.equal(failure?.code, 'ERR_SQLITE_ERROR')
  const fault = t.mock.method(database, 'prepare', () => { throw failure })
  try {
    assert.throws(() => loadCommentPage(database, { videoId: 1, page: 1, limit: 20 }), error => error === failure)
  } finally {
    fault.mock.restore()
  }
  assert.deepEqual(plain(loadCommentPage(database, { videoId: 1, page: 1, limit: 20 })), [initial])
  assert.deepEqual(snapshot(database, path), before)
  database.close()
  assert.throws(() => loadCommentPage(database, { videoId: 1, page: 1, limit: 20 }))
  assert.equal(database.isOpen, false)
  const reopened = context.open(path)
  assert.deepEqual(plain(loadCommentPage(reopened, { videoId: 1, page: 1, limit: 20 })), [initial])
  assert.deepEqual(snapshot(reopened, path), before)
})
