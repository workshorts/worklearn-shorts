import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { insertVideoView } from '../../src/db/video-view-writes.js'
import { withVideoWriteTransaction } from '../../src/services/video-write.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const visitorA = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const visitorB = '12345678-abcd-4abc-9def-012345abcdef'
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('video-view-writes.db')
  context.initialize(path)
  const database = context.open(path)
  return { context, path, database, ...insertMinimalFixture(database) }
}

function snapshot(database) {
  return Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()]))
}

function insert(database, videoId, visitorId) {
  return withVideoWriteTransaction(database, videoId, connection => insertVideoView(connection, { videoId, visitorId }))
}

function secondVideo(database) {
  return database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Second write target', 'videos/10000000-0000-4000-8000-000000000002.mp4').lastInsertRowid
}

test('one pair is inserted once and duplicates preserve its row identity, timestamp and all unrelated tables', t => {
  const { database, videoId } = setup(t)
  const before = snapshot(database)
  assert.equal(insert(database, videoId, visitorA).changes, 1)
  database.prepare('UPDATE video_views SET created_at = ? WHERE video_id = ? AND visitor_id = ?')
    .run('2001-02-03T04:05:06.000Z', videoId, visitorA)
  const saved = snapshot(database)
  for (let iteration = 0; iteration < 3; iteration += 1) {
    assert.equal(insert(database, videoId, visitorA).changes, 0)
    assert.deepEqual(snapshot(database), saved)
  }
  for (const table of tables.filter(table => table !== 'video_views')) {
    assert.deepEqual(saved[table], before[table])
  }
  assert.equal(saved.video_views.length, before.video_views.length + 1)
})

test('distinct video and visitor pairs remain independent while only the matching pair is ignored', t => {
  const { database, videoId } = setup(t)
  const otherVideo = secondVideo(database)
  for (const [id, visitor] of [[videoId, visitorA], [videoId, visitorB], [otherVideo, visitorA]]) {
    assert.equal(insert(database, id, visitor).changes, 1)
  }
  assert.equal(insert(database, otherVideo, visitorA).changes, 0)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_views').get().count, 4)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_views WHERE video_id = ?').get(videoId).count, 3)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_views WHERE video_id = ?').get(otherVideo).count, 1)
})

test('insertion outside a caller transaction fails before preparing or executing SQL', t => {
  const { database, videoId } = setup(t)
  const before = snapshot(database)
  const prepare = t.mock.method(database, 'prepare', () => assert.fail('No SQL is allowed before the transaction guard'))
  assert.throws(() => insertVideoView(database, { videoId, visitorId: visitorA }),
    { message: 'Video view insertion requires an active transaction.' })
  assert.equal(prepare.mock.callCount(), 0)
  assert.equal(database.isTransaction, false)
  prepare.mock.restore()
  assert.deepEqual(snapshot(database), before)
})

test('foreign key and not-null failures propagate instead of being mistaken for a duplicate', t => {
  const { database, videoId } = setup(t)
  const before = snapshot(database)
  for (const [values, code] of [[{ videoId: 999999, visitorId: visitorA }, 787],
    [{ videoId, visitorId: null }, 1299], [{ videoId: null, visitorId: visitorA }, 1299]]) {
    assert.throws(() => withVideoWriteTransaction(database, videoId, connection => insertVideoView(connection, values)), error => {
      assert.equal(error instanceof ApiError, false)
      assert.equal(error.code, 'ERR_SQLITE_ERROR')
      assert.equal(error.errcode, code)
      return true
    })
    assert.equal(database.isTransaction, false)
    assert.equal(database.isOpen, true)
    assert.deepEqual(snapshot(database), before)
  }
})

test('an unexpected unique constraint outside the video and visitor key still fails', t => {
  const { database, videoId, visitorId } = setup(t)
  const otherVideo = secondVideo(database)
  // This stricter index belongs only to the owned test DB and simulates an unrelated constraint.
  database.exec('CREATE UNIQUE INDEX test_view_visitor_unique ON video_views(visitor_id)')
  const before = snapshot(database)
  assert.throws(() => insert(database, otherVideo, visitorId), error => {
    assert.equal(error.code, 'ERR_SQLITE_ERROR')
    assert.equal(error.errcode, 2067)
    return true
  })
  assert.deepEqual(snapshot(database), before)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_views WHERE video_id = ?').get(videoId).count, 1)
})

test('the insert leaves commit ownership to the caller and is rolled back on a later failure before retry', t => {
  const { database, videoId } = setup(t)
  const before = snapshot(database)
  const failure = new Error('Injected failure after view insertion')
  assert.throws(() => withVideoWriteTransaction(database, videoId, connection => {
    assert.equal(insertVideoView(connection, { videoId, visitorId: visitorA }).changes, 1)
    assert.equal(connection.isTransaction, true)
    throw failure
  }), error => error === failure)
  assert.deepEqual(snapshot(database), before)
  assert.equal(database.isTransaction, false)
  assert.equal(insert(database, videoId, visitorA).changes, 1)
})

test('a committed pair remains a duplicate when another actual connection writes it again', t => {
  const { context, path, database, videoId } = setup(t)
  assert.equal(insert(database, videoId, visitorA).changes, 1)
  const before = snapshot(database)
  const other = context.open(path)
  assert.equal(insert(other, videoId, visitorA).changes, 0)
  assert.deepEqual(snapshot(other), before)
  assert.equal(other.isTransaction, false)
  assert.equal(other.isOpen, true)
})
