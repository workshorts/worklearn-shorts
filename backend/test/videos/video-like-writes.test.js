import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { insertVideoLike } from '../../src/db/video-like-writes.js'
import { addVideoLike } from '../../src/services/video-like.js'
import { withVideoWriteTransaction } from '../../src/services/video-write.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const visitorA = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const visitorB = '12345678-abcd-4abc-9def-012345abcdef'
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('video-like-writes.db')
  context.initialize(path)
  const database = context.open(path)
  return { context, path, database, ...insertMinimalFixture(database) }
}

function snapshot(database, path) {
  return {
    rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }
}

function assertReady(database) {
  assert.equal(database.isTransaction, false)
  assert.equal(database.isOpen, true)
}

function assertNativeFailure(operation, code) {
  assert.throws(operation, error => {
    assert.equal(error instanceof ApiError, false)
    assert.equal(error.code, 'ERR_SQLITE_ERROR')
    assert.equal(error.errcode, code)
    return true
  })
}

function secondVideo(database) {
  return database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Second like target', 'videos/10000000-0000-4000-8000-000000000002.mp4').lastInsertRowid
}

test('a like is added once and duplicates preserve its row, original time, unrelated data and database file', t => {
  const { database, path, videoId } = setup(t)
  const before = snapshot(database, path)
  assert.equal(addVideoLike(database, { id: videoId, visitorId: visitorA }).changes, 1)
  assertReady(database)
  const inserted = snapshot(database, path)
  const pair = row => row.video_id === videoId && row.visitor_id === visitorA
  assert.equal(inserted.rows.video_likes.filter(pair).length, 1)
  assert.deepEqual(inserted.rows.video_likes.filter(row => !pair(row)), before.rows.video_likes)
  for (const table of tables.filter(table => table !== 'video_likes')) {
    assert.deepEqual(inserted.rows[table], before.rows[table])
  }
  assert.deepEqual(inserted.schema, before.schema)
  database.prepare('UPDATE video_likes SET created_at = ? WHERE video_id = ? AND visitor_id = ?')
    .run('2001-02-03T04:05:06.000Z', videoId, visitorA)
  const saved = snapshot(database, path)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(addVideoLike(database, { id: videoId, visitorId: visitorA }).changes, 0)
    assertReady(database)
    assert.deepEqual(snapshot(database, path), saved)
  }
})

test('different video and visitor pairs are independent and never add a view', t => {
  const { database, path, videoId, visitorId } = setup(t)
  const otherId = secondVideo(database)
  const before = snapshot(database, path)
  const pairs = [[videoId, visitorA], [videoId, visitorB], [otherId, visitorA]]
  for (const [id, visitor] of pairs) {
    assert.equal(addVideoLike(database, { id, visitorId: visitor }).changes, 1)
    assertReady(database)
  }
  const saved = snapshot(database, path)
  for (const [id, visitor] of pairs) {
    assert.equal(addVideoLike(database, { id, visitorId: visitor }).changes, 0)
    assertReady(database)
    assert.deepEqual(snapshot(database, path), saved)
  }
  assert.deepEqual(saved.rows.video_likes.map(row => [row.video_id, row.visitor_id]),
    [[videoId, visitorId], ...pairs])
  for (const table of tables.filter(table => table !== 'video_likes')) {
    assert.deepEqual(saved.rows[table], before.rows[table])
  }
})

test('the raw like insert rejects calls outside a transaction before SQL', t => {
  const { database, path, videoId } = setup(t)
  const before = snapshot(database, path)
  const prepare = t.mock.method(database, 'prepare', () => assert.fail('No SQL is allowed before the transaction guard'))
  try {
    assert.throws(() => insertVideoLike(database, { videoId, visitorId: visitorA }),
      { message: 'Video like insertion requires an active transaction.' })
    assert.equal(prepare.mock.callCount(), 0)
  } finally { prepare.mock.restore() }
  assertReady(database)
  assert.deepEqual(snapshot(database, path), before)
})

test('foreign-key and not-null errors propagate rather than becoming successful duplicates', t => {
  const { database, path, videoId } = setup(t)
  const before = snapshot(database, path)
  for (const [values, code] of [[{ videoId: 999999, visitorId: visitorA }, 787],
    [{ videoId, visitorId: null }, 1299], [{ videoId: null, visitorId: visitorA }, 1299]]) {
    assertNativeFailure(() => withVideoWriteTransaction(database, videoId,
      connection => insertVideoLike(connection, values)), code)
    assertReady(database)
    assert.deepEqual(snapshot(database, path), before)
  }
})

test('an unrelated native unique constraint still fails through the like service', t => {
  const { database, path, videoId, visitorId } = setup(t)
  const otherId = secondVideo(database)
  // This extra constraint exists only in the owned test DB.
  database.exec('CREATE UNIQUE INDEX test_like_visitor_unique ON video_likes(visitor_id)')
  const before = snapshot(database, path)
  assertNativeFailure(() => addVideoLike(database, { id: otherId, visitorId }), 2067)
  assertReady(database)
  assert.deepEqual(snapshot(database, path), before)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_likes WHERE video_id = ?').get(videoId).count, 1)
})

test('missing videos are rejected by the shared write boundary without creating an orphan like', t => {
  const { database, path } = setup(t)
  const before = snapshot(database, path)
  for (const id of [999999, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => addVideoLike(database, { id, visitorId: visitorA }), error => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 404)
      assert.equal(error.code, 'NOT_FOUND')
      assert.equal(error.message, '영상을 찾을 수 없습니다.')
      assert.deepEqual(error.fields, {})
      return true
    })
    assertReady(database)
    assert.deepEqual(snapshot(database, path), before)
  }
})

test('a later native error rolls back the like before a new retry can commit', t => {
  const { database, path, videoId } = setup(t)
  const before = snapshot(database, path)
  assertNativeFailure(() => withVideoWriteTransaction(database, videoId, connection => {
    assert.equal(insertVideoLike(connection, { videoId, visitorId: visitorA }).changes, 1)
    assert.equal(connection.isTransaction, true)
    connection.prepare('INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)').run(999999, visitorA)
  }), 787)
  assertReady(database)
  assert.deepEqual(snapshot(database, path), before)
  assert.equal(addVideoLike(database, { id: videoId, visitorId: visitorA }).changes, 1)
  assert.equal(addVideoLike(database, { id: videoId, visitorId: visitorA }).changes, 0)
})

test('a failed like commit is rolled back and preserves the original error before recovery', t => {
  const { database, path, videoId } = setup(t)
  const before = snapshot(database, path)
  const failure = new Error('Injected like commit failure')
  const exec = database.exec.bind(database)
  const fault = t.mock.method(database, 'exec', sql => {
    if (sql === 'COMMIT') throw failure
    return exec(sql)
  })
  try {
    assert.throws(() => addVideoLike(database, { id: videoId, visitorId: visitorA }), error => error === failure)
  } finally { fault.mock.restore() }
  assertReady(database)
  assert.deepEqual(snapshot(database, path), before)
  assert.equal(addVideoLike(database, { id: videoId, visitorId: visitorA }).changes, 1)
  assert.equal(addVideoLike(database, { id: videoId, visitorId: visitorA }).changes, 0)
})

test('committed likes remain duplicates across independent connections and reopening', t => {
  const { context, path, database, videoId } = setup(t)
  assert.equal(addVideoLike(database, { id: videoId, visitorId: visitorA }).changes, 1)
  const saved = snapshot(database, path)
  const other = context.open(path)
  assert.equal(addVideoLike(other, { id: videoId, visitorId: visitorA }).changes, 0)
  assertReady(other)
  assert.deepEqual(snapshot(other, path), saved)
  assert.deepEqual(snapshot(database, path), saved)
  database.close()
  other.close()
  const reopened = context.open(path)
  assert.equal(addVideoLike(reopened, { id: videoId, visitorId: visitorA }).changes, 0)
  assertReady(reopened)
  assert.deepEqual(snapshot(reopened, path), saved)
  assert.equal(reopened.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
})
