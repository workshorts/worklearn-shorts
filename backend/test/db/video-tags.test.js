import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('video-tags.db')
  context.initialize(path)
  const database = context.open(path)
  const ids = insertMinimalFixture(database)
  const secondVideoId = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Second video', '/uploads/videos/test-only-second.mp4').lastInsertRowid
  const secondTagId = database.prepare('INSERT INTO tags (name) VALUES (?)')
    .run('Second tag').lastInsertRowid
  return { context, path, database, ...ids, secondVideoId, secondTagId }
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
    // Require the composite primary-key error rather than a missing parent.
    assert.equal(error.code, 'ERR_SQLITE_ERROR')
    assert.equal(error.errcode, 1555)
    return true
  })
  assert.deepEqual(snapshotRows(database), before)
  assert.equal(database.isTransaction, false)
}

function readPairs(database) {
  return database.prepare('SELECT video_id, tag_id FROM video_tags ORDER BY video_id, tag_id')
    .all().map(row => [row.video_id, row.tag_id])
}

test('video-tag INSERT rejects identical pairs while allowing many-to-many links', { timeout: 10000 }, t => {
  const { database, videoId, tagId, secondVideoId, secondTagId } = setup(t)
  const insert = database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
  const before = snapshotRows(database)
  assertRejected(database, () => insert.run(videoId, tagId))

  const additional = [[videoId, secondTagId], [secondVideoId, tagId], [secondVideoId, secondTagId]]
  for (const pair of additional) {
    assert.equal(insert.run(...pair).changes, 1)
    assertRejected(database, () => insert.run(...pair))
  }

  assert.deepEqual(readPairs(database), [[videoId, tagId], ...additional])
  const after = snapshotRows(database)
  for (const table of snapshotTables.filter(table => table !== 'video_tags')) {
    assert.deepEqual(after[table], before[table])
  }
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('video-tag UPDATE rejects collisions on either key or both without losing existing links', { timeout: 10000 }, t => {
  const { database, videoId, tagId, secondVideoId, secondTagId } = setup(t)
  const insert = database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
  insert.run(secondVideoId, tagId)
  insert.run(videoId, secondTagId)
  insert.run(secondVideoId, secondTagId)
  const update = database.prepare(
    'UPDATE video_tags SET video_id = ?, tag_id = ? WHERE video_id = ? AND tag_id = ?'
  )
  const sources = [[secondVideoId, tagId], [videoId, secondTagId], [secondVideoId, secondTagId]]

  for (const source of sources) {
    assert.equal(database.prepare('SELECT count(*) AS count FROM video_tags WHERE video_id = ? AND tag_id = ?')
      .get(...source).count, 1)
    assertRejected(database, () => update.run(videoId, tagId, ...source))
  }

  const beforeSelfUpdate = snapshotRows(database)
  assert.equal(update.run(videoId, tagId, videoId, tagId).changes, 1)
  assert.deepEqual(snapshotRows(database), beforeSelfUpdate)

  const thirdVideoId = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Third video', '/uploads/videos/test-only-third.mp4').lastInsertRowid
  const beforeMove = snapshotRows(database)
  // Changing only the conflicting target video makes the same UPDATE valid.
  assert.equal(update.run(thirdVideoId, tagId, secondVideoId, secondTagId).changes, 1)
  const afterMove = snapshotRows(database)
  for (const table of snapshotTables.filter(table => table !== 'video_tags')) {
    assert.deepEqual(afterMove[table], beforeMove[table])
  }
  assert.deepEqual(readPairs(database), [
    [videoId, tagId], [videoId, secondTagId], [secondVideoId, tagId], [thirdVideoId, tagId]
  ])
  assert.equal(insert.run(secondVideoId, secondTagId).changes, 1)
  assert.equal(readPairs(database).length, 5)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('video-tag pair uniqueness is enforced across connections and after reopening', { timeout: 10000 }, t => {
  const { context, path, database, videoId, tagId, secondVideoId, secondTagId } = setup(t)
  database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(secondVideoId, secondTagId)
  const before = snapshotRows(database)
  const second = context.open(path)
  assert.deepEqual(snapshotRows(second), before)
  assertRejected(second, () => second.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
    .run(secondVideoId, secondTagId))
  assertRejected(second, () => second.prepare(
    'UPDATE video_tags SET video_id = ?, tag_id = ? WHERE video_id = ? AND tag_id = ?'
  ).run(videoId, tagId, secondVideoId, secondTagId))
  assert.deepEqual(snapshotRows(database), before)
  database.close()
  second.close()

  const reopened = context.open(path)
  assert.deepEqual(snapshotRows(reopened), before)
  assertRejected(reopened, () => reopened.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
    .run(videoId, tagId))
  assert.equal(reopened.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
    .run(videoId, secondTagId).changes, 1)
  assert.deepEqual(readPairs(reopened), [[videoId, tagId], [videoId, secondTagId], [secondVideoId, secondTagId]])
  assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
})
