import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { loadCommentList } from '../../src/services/comment-read.js'
import { withTransaction } from '../../src/db/transaction.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('comment-list.db')
  context.initialize(path)
  const database = context.open(path)
  const fixture = insertMinimalFixture(database)
  database.prepare('UPDATE comments SET created_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', fixture.commentId)
  return { database, context, path, fixture }
}

test('the list service composes public data and total in deferred transactions and distinguishes empty from missing parents', t => {
  const { database, path, fixture } = setup(t)
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(2, 'Empty parent', 'unused-path')
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  })
  database.exec('PRAGMA query_only = ON')
  const before = snapshot()
  const commands = []
  const exec = database.exec.bind(database)
  const observed = t.mock.method(database, 'exec', sql => { commands.push(sql); return exec(sql) })
  try {
    assert.deepEqual(loadCommentList(database, { id: fixture.videoId, page: 1, limit: 20 }), {
      data: [{ id: fixture.commentId, videoId: fixture.videoId, nickname: 'Fixture user', content: 'Fixture comment',
        createdAt: '2000-01-01T00:00:00.000Z' }], total: 1,
    })
    assert.deepEqual(loadCommentList(database, { id: 2, page: 1, limit: 20 }), { data: [], total: 0 })
    assert.throws(() => loadCommentList(database, { id: Number.MAX_SAFE_INTEGER, page: 1, limit: 20 }), error =>
      error instanceof ApiError && error.status === 404 && error.message === '영상을 찾을 수 없습니다.')
    assert.deepEqual(commands, ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT', 'BEGIN', 'ROLLBACK'])
  } finally {
    observed.mock.restore()
  }
  assert.equal(database.isOpen, true)
  assert.equal(database.isTransaction, false)
  assert.deepEqual(snapshot(), before)
})

test('the service holds its snapshot when a writer commits between counting and page assembly', t => {
  const { database, context, path, fixture } = setup(t)
  assert.equal(database.prepare('PRAGMA journal_mode = WAL').get().journal_mode, 'wal')
  const writer = context.open(path)
  const prepare = database.prepare.bind(database)
  let changed = false
  const observed = t.mock.method(database, 'prepare', sql => {
    const statement = prepare(sql)
    if (sql.startsWith('SELECT COUNT(*)')) {
      const get = statement.get.bind(statement)
      t.mock.method(statement, 'get', (...params) => {
        assert.equal(database.isTransaction, true)
        const result = get(...params)
        if (!changed) {
          withTransaction(writer, connection => {
            connection.prepare('DELETE FROM comments WHERE id = ?').run(fixture.commentId)
            const insert = connection.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)')
            insert.run(fixture.videoId, 'Writer', 'test-only-hash', 'New first')
            insert.run(fixture.videoId, 'Writer', 'test-only-hash', 'New second')
          })
          changed = true
        }
        return result
      })
    }
    return statement
  })
  try {
    assert.deepEqual(loadCommentList(database, { id: fixture.videoId, page: 1, limit: 20 }), {
      data: [{ id: fixture.commentId, videoId: fixture.videoId, nickname: 'Fixture user', content: 'Fixture comment',
        createdAt: '2000-01-01T00:00:00.000Z' }], total: 1,
    })
  } finally {
    observed.mock.restore()
  }
  assert.equal(changed, true)
  const next = loadCommentList(database, { id: fixture.videoId, page: 1, limit: 20 })
  assert.equal(next.total, 2)
  assert.equal(next.data.length, 2)
  assert.ok(next.data.every(row => row.id !== fixture.commentId))
  assert.equal(database.isTransaction, false)
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})
