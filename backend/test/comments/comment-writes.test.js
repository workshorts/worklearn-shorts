import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assertCommentVideoExists } from '../../src/db/comment-queries.js'
import { insertComment } from '../../src/db/comment-writes.js'
import { ApiError } from '../../src/errors.js'
import { hashPassword, verifyPassword } from '../../src/lib/password.js'
import { withVideoWriteTransaction } from '../../src/services/video-write.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const password = ' 12 '
const passwordHash = hashPassword(password)
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('comment-writes.db')
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

function candidate(id, extra = {}) {
  return { id, nickname: ' Author ', passwordHash, content: ' First\nSecond 😀 ', ...extra }
}

function insert(db, input) {
  return withVideoWriteTransaction(db, input.id, connection => insertComment(connection, input))
}

test('comment insertion stores the exact hash and bound text, uses DB identity and time, and returns public columns only', t => {
  const { db, context, path, videoId } = setup(t)
  const before = snapshot(db, path)
  let hashReads = 0
  const input = Object.freeze({
    ...candidate(videoId, { nickname: "' OR 1=1 --", content: "Literal ?; DROP TABLE videos; --\n😀", videoId: 999 }),
    get passwordHash() { hashReads += 1; return hashReads === 1 ? passwordHash : password },
    get password() { assert.fail('Plaintext must not be read by storage') },
    get createdAt() { assert.fail('Client timestamps must not be read') },
    get password_hash() { assert.fail('Extra hash aliases must not be read') },
  })
  const started = Date.now()
  const row = insert(db, input)
  assert.equal(hashReads, 1)
  assert.deepEqual(Object.keys(row), ['id', 'video_id', 'nickname', 'content', 'created_at'])
  assert.ok(Number.isSafeInteger(row.id) && row.id > 0)
  assert.equal(row.video_id, videoId)
  assert.equal(row.nickname, input.nickname)
  assert.equal(row.content, input.content)
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.ok(Date.parse(row.created_at) >= started - 1000 && Date.parse(row.created_at) <= Date.now() + 1000)
  const saved = context.open(path).prepare('SELECT * FROM comments WHERE id = ?').get(row.id)
  assert.deepEqual({ ...saved }, { ...row, password_hash: passwordHash })
  assert.equal(verifyPassword(password, saved.password_hash), true)
  assert.equal(verifyPassword(password.trim(), saved.password_hash), false)
  const after = snapshot(db, path)
  for (const table of tables.filter(table => table !== 'comments' && table !== 'sqlite_sequence')) {
    assert.deepEqual(after.rows[table], before.rows[table])
  }
  assert.deepEqual(after.rows.comments.slice(0, -1), before.rows.comments)
  assert.deepEqual(after.schema, before.schema)
  assert.equal(db.isTransaction, false)
})

test('repeated identical comments create independent records and never replace existing comments or other videos', t => {
  const { db, videoId, commentId } = setup(t)
  const existing = db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId)
  const otherId = db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)').run('Other target', 'unused-path').lastInsertRowid
  const rows = [insert(db, candidate(videoId)), insert(db, candidate(videoId)), insert(db, candidate(otherId))]
  assert.equal(new Set(rows.map(row => row.id)).size, 3)
  assert.deepEqual(rows.map(row => row.video_id), [videoId, videoId, otherId])
  assert.deepEqual(db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId), existing)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM comments').get().count, 4)
})

test('comment storage requires an open caller transaction before any SQL is prepared', t => {
  const { db, path, videoId, context } = setup(t)
  const before = snapshot(db, path)
  const prepared = t.mock.method(db, 'prepare', () => assert.fail('Invalid storage context must not prepare SQL'))
  try {
    assert.throws(() => insertComment(db, candidate(videoId)), { message: 'Comment insertion requires an active transaction.' })
    db.close()
    assert.throws(() => insertComment(db, candidate(videoId)), { message: 'Database connection is closed.' })
    assert.equal(prepared.mock.callCount(), 0)
  } finally {
    prepared.mock.restore()
  }
  assert.deepEqual(snapshot(context.open(path), path), before)
})

test('plaintext and malformed password hashes are rejected before insertion without ending the caller transaction', t => {
  const { db, videoId, path } = setup(t)
  const before = snapshot(db, path)
  const invalid = [undefined, null, [], 'plain-candidate', {},
    ...[password, undefined, null, '', 1234, [], passwordHash + '\n', passwordHash + '$extra',
      passwordHash.toUpperCase(), passwordHash.replace('16384', '8192')].map(value => candidate(videoId, { passwordHash: value }))]
  withVideoWriteTransaction(db, videoId, connection => {
    const prepare = t.mock.method(connection, 'prepare', () => assert.fail('Only prepared password hashes may reach SQL'))
    try {
      for (const input of invalid) {
        assert.throws(() => insertComment(connection, input),
          { name: 'TypeError', message: 'Comment insertion requires a prepared password hash.' })
        assert.equal(connection.isTransaction, true)
      }
      assert.equal(prepare.mock.callCount(), 0)
    } finally {
      prepare.mock.restore()
    }
  })
  assert.deepEqual(snapshot(db, path), before)
})

test('a later failure rolls back the inserted comment, generated ID sequence and all other state before retry', t => {
  const { db, videoId, path } = setup(t)
  const before = snapshot(db, path)
  const failure = new Error('Expected failure after comment insertion')
  assert.throws(() => withVideoWriteTransaction(db, videoId, connection => {
    const row = insertComment(connection, candidate(videoId))
    assert.equal(connection.isTransaction, true)
    assert.equal(connection.prepare('SELECT password_hash FROM comments WHERE id = ?').get(row.id).password_hash, passwordHash)
    throw failure
  }), error => error === failure)
  assert.equal(db.isTransaction, false)
  assert.deepEqual(snapshot(db, path), before)
  assert.equal(insert(db, candidate(videoId)).id, before.rows.comments.at(-1).id + 1)
})

test('commit failure cannot return a stored comment and rolls back before the next insertion recovers', t => {
  const { db, path, videoId } = setup(t)
  const before = snapshot(db, path)
  const failure = new Error('Expected comment commit failure')
  const exec = db.exec.bind(db)
  const fault = t.mock.method(db, 'exec', sql => {
    if (sql === 'COMMIT') throw failure
    return exec(sql)
  })
  try {
    assert.throws(() => insert(db, candidate(videoId)), error => error === failure)
  } finally {
    fault.mock.restore()
  }
  assert.equal(db.isTransaction, false)
  assert.deepEqual(snapshot(db, path), before)
  assert.equal(insert(db, candidate(videoId)).video_id, videoId)
})

test('foreign key, not-null, check and unexpected unique constraints remain errors and roll back all writes', t => {
  const { db, path, videoId } = setup(t)
  db.exec('CREATE UNIQUE INDEX test_comment_content_unique ON comments(content)')
  const before = snapshot(db, path)
  const invalid = [[{ id: 999999 }, 787], [{ nickname: null }, 1299], [{ content: null }, 1299],
    [{ nickname: '' }, 275], [{ nickname: 'x'.repeat(21) }, 275], [{ content: '' }, 275],
    [{ content: 'x'.repeat(501) }, 275], [{ content: 'Fixture comment' }, 2067]]
  for (const [extra, errcode] of invalid) {
    assert.throws(() => withVideoWriteTransaction(db, videoId, connection => {
      insertComment(connection, candidate(videoId))
      insertComment(connection, candidate(videoId, { content: 'Second attempted comment', ...extra }))
    }), error => !(error instanceof ApiError) && error.code === 'ERR_SQLITE_ERROR' && error.errcode === errcode)
    assert.equal(db.isTransaction, false)
    assert.deepEqual(snapshot(db, path), before)
  }
})

test('the actual insert rechecks deleted targets and shares the write lock until commit with safe cascade afterward', t => {
  const { context, db, path, videoId } = setup(t)
  const other = context.open(path)
  other.exec('PRAGMA busy_timeout = 0')
  const lostId = db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)').run('Deleted target', 'unused-path').lastInsertRowid
  assertCommentVideoExists(db, lostId)
  const prepared = candidate(lostId)
  other.prepare('DELETE FROM videos WHERE id = ?').run(lostId)
  const before = snapshot(db, path)
  assert.throws(() => insert(db, prepared), error => error instanceof ApiError && error.status === 404)
  assert.deepEqual(snapshot(db, path), before)
  const row = withVideoWriteTransaction(db, videoId, connection => {
    assert.throws(() => other.prepare('DELETE FROM videos WHERE id = ?').run(videoId),
      error => error.code === 'ERR_SQLITE_ERROR' && error.errcode === 5)
    return insertComment(connection, candidate(videoId))
  })
  assert.ok(other.prepare('SELECT id FROM comments WHERE id = ?').get(row.id))
  assert.equal(other.prepare('DELETE FROM videos WHERE id = ?').run(videoId).changes, 1)
  assert.equal(db.prepare('SELECT * FROM comments WHERE id = ?').get(row.id), undefined)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
})
