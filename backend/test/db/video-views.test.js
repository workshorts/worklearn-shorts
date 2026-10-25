import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const secondVisitorId = '00000000-0000-4000-8000-000000000002'
const thirdVisitorId = '00000000-0000-4000-8000-000000000003'
const controlTime = '2001-02-03T04:05:06.007Z'
const differentTime = '2002-03-04T05:06:07.008Z'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('video-views.db')
  context.initialize(path)
  const database = context.open(path)
  const ids = insertMinimalFixture(database)
  const secondVideoId = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Second video', '/uploads/videos/test-only-second.mp4').lastInsertRowid
  return { context, path, database, ...ids, secondVideoId }
}

const snapshotTables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function snapshotRows(database) {
  return Object.fromEntries(snapshotTables.map(table => [
    table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
  ]))
}

function assertRejected(database, write) {
  const before = snapshotRows(database)
  assert.throws(write, error => {
    // A different timestamp must still conflict with the same composite key.
    assert.equal(error.code, 'ERR_SQLITE_ERROR')
    assert.equal(error.errcode, 1555)
    return true
  })
  assert.deepEqual(snapshotRows(database), before)
  assert.equal(database.isTransaction, false)
}

function readRecords(database) {
  return database.prepare('SELECT * FROM video_views ORDER BY video_id, visitor_id')
    .all().map(row => [row.video_id, row.visitor_id, row.created_at])
}

test('view INSERT rejects duplicate video and UUID even at another time while allowing independent records', { timeout: 10000 }, t => {
  const { database, videoId, visitorId, secondVideoId } = setup(t)
  const original = database.prepare('SELECT * FROM video_views WHERE video_id = ? AND visitor_id = ?')
    .get(videoId, visitorId)
  const before = snapshotRows(database)
  const insert = database.prepare('INSERT INTO video_views (video_id, visitor_id, created_at) VALUES (?, ?, ?)')
  assert.notEqual(original.created_at, differentTime)
  assertRejected(database, () => database.prepare('INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)')
    .run(videoId, visitorId))
  assertRejected(database, () => insert.run(videoId, visitorId, differentTime))

  const additional = [[videoId, secondVisitorId], [secondVideoId, visitorId], [secondVideoId, secondVisitorId]]
  for (const pair of additional) {
    assert.equal(insert.run(...pair, controlTime).changes, 1)
    assertRejected(database, () => insert.run(...pair, differentTime))
  }

  assert.deepEqual(readRecords(database), [
    [videoId, visitorId, original.created_at], ...additional.map(pair => [...pair, controlTime])
  ])
  assert.deepEqual(database.prepare('SELECT video_id, count(*) AS count FROM video_views GROUP BY video_id ORDER BY video_id')
    .all().map(row => [row.video_id, row.count]), [[videoId, 2], [secondVideoId, 2]])
  const after = snapshotRows(database)
  for (const table of snapshotTables.filter(table => table !== 'video_views')) {
    assert.deepEqual(after[table], before[table])
  }
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('view UPDATE rejects collisions on either key or both and preserves original timestamps', { timeout: 10000 }, t => {
  const { database, videoId, visitorId, secondVideoId } = setup(t)
  const originalTime = database.prepare('SELECT created_at FROM video_views WHERE video_id = ? AND visitor_id = ?')
    .get(videoId, visitorId).created_at
  const insert = database.prepare('INSERT INTO video_views (video_id, visitor_id, created_at) VALUES (?, ?, ?)')
  const sources = [[secondVideoId, visitorId], [videoId, secondVisitorId], [secondVideoId, secondVisitorId]]
  for (const source of sources) {
    insert.run(...source, controlTime)
  }
  const update = database.prepare(
    'UPDATE video_views SET video_id = ?, visitor_id = ?, created_at = ? WHERE video_id = ? AND visitor_id = ?'
  )
  for (const source of sources) {
    assert.equal(database.prepare('SELECT count(*) AS count FROM video_views WHERE video_id = ? AND visitor_id = ?')
      .get(...source).count, 1)
    assertRejected(database, () => update.run(videoId, visitorId, differentTime, ...source))
  }

  const before = snapshotRows(database)
  assert.equal(update.run(videoId, visitorId, originalTime, videoId, visitorId).changes, 1)
  assert.deepEqual(snapshotRows(database), before)
  // Only the target UUID changes from the last rejected UPDATE.
  assert.equal(update.run(videoId, thirdVisitorId, differentTime, secondVideoId, secondVisitorId).changes, 1)
  assert.deepEqual(readRecords(database), [
    [videoId, visitorId, originalTime], [videoId, secondVisitorId, controlTime],
    [videoId, thirdVisitorId, differentTime], [secondVideoId, visitorId, controlTime]
  ])
  assert.equal(insert.run(secondVideoId, secondVisitorId, controlTime).changes, 1)
  assert.equal(readRecords(database).length, 5)
  const after = snapshotRows(database)
  for (const table of snapshotTables.filter(table => table !== 'video_views')) {
    assert.deepEqual(after[table], before[table])
  }
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('view uniqueness and first timestamps persist across connections and after reopening', { timeout: 10000 }, t => {
  const { context, path, database, videoId, visitorId, secondVideoId } = setup(t)
  database.prepare('INSERT INTO video_views (video_id, visitor_id, created_at) VALUES (?, ?, ?)')
    .run(secondVideoId, secondVisitorId, controlTime)
  const originalTime = database.prepare('SELECT created_at FROM video_views WHERE video_id = ? AND visitor_id = ?')
    .get(videoId, visitorId).created_at
  const before = snapshotRows(database)
  const second = context.open(path)
  assert.deepEqual(snapshotRows(second), before)
  assertRejected(second, () => second.prepare('INSERT INTO video_views (video_id, visitor_id, created_at) VALUES (?, ?, ?)')
    .run(secondVideoId, secondVisitorId, differentTime))
  assertRejected(second, () => second.prepare(
    'UPDATE video_views SET video_id = ?, visitor_id = ?, created_at = ? WHERE video_id = ? AND visitor_id = ?'
  ).run(videoId, visitorId, differentTime, secondVideoId, secondVisitorId))
  assert.deepEqual(snapshotRows(database), before)
  database.close()
  second.close()

  const reopened = context.open(path)
  assert.deepEqual(snapshotRows(reopened), before)
  assertRejected(reopened, () => reopened.prepare('INSERT INTO video_views (video_id, visitor_id, created_at) VALUES (?, ?, ?)')
    .run(videoId, visitorId, differentTime))
  assert.equal(reopened.prepare('INSERT INTO video_views (video_id, visitor_id, created_at) VALUES (?, ?, ?)')
    .run(videoId, secondVisitorId, controlTime).changes, 1)
  assert.deepEqual(readRecords(reopened), [
    [videoId, visitorId, originalTime], [videoId, secondVisitorId, controlTime],
    [secondVideoId, secondVisitorId, controlTime]
  ])
  assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
})
