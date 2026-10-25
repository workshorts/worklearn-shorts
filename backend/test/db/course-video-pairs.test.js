import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('course-video-pairs.db')
  context.initialize(path)
  const database = context.open(path)
  const ids = insertMinimalFixture(database)
  const secondCourseId = database.prepare('INSERT INTO courses (name) VALUES (?)')
    .run('Second course').lastInsertRowid
  const secondVideoId = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Second video', '/uploads/videos/test-only-second.mp4').lastInsertRowid
  return { context, path, database, ...ids, secondCourseId, secondVideoId }
}

const snapshotTables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function snapshotRows(database) {
  return Object.fromEntries(snapshotTables.map(table => [
    table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
  ]))
}

function assertPairRejected(database, courseId, sortOrder, write) {
  // Keep the separate course-order UNIQUE constraint out of this failure.
  assert.equal(database.prepare('SELECT count(*) AS count FROM course_videos WHERE course_id = ? AND sort_order = ?')
    .get(courseId, sortOrder).count, 0)
  const before = snapshotRows(database)
  assert.throws(write, error => {
    assert.equal(error.code, 'ERR_SQLITE_ERROR')
    assert.equal(error.errcode, 1555)
    return true
  })
  assert.deepEqual(snapshotRows(database), before)
  assert.equal(database.isTransaction, false)
}

function readLinks(database) {
  return database.prepare('SELECT course_id, video_id, sort_order FROM course_videos ORDER BY course_id, video_id')
    .all().map(row => [row.course_id, row.video_id, row.sort_order])
}

test('course-video INSERT rejects the same pair at an unused order while allowing many-to-many links', { timeout: 10000 }, t => {
  const { database, courseId, videoId, secondCourseId, secondVideoId } = setup(t)
  const insert = database.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)')
  const before = snapshotRows(database)
  assertPairRejected(database, courseId, 99, () => insert.run(courseId, videoId, 99))
  const additional = [[courseId, secondVideoId, 2], [secondCourseId, videoId, 1], [secondCourseId, secondVideoId, 2]]

  for (const link of additional) {
    assert.equal(insert.run(...link).changes, 1)
    assertPairRejected(database, link[0], 99, () => insert.run(link[0], link[1], 99))
  }

  assert.deepEqual(readLinks(database), [[courseId, videoId, 1], ...additional])
  const after = snapshotRows(database)
  for (const table of snapshotTables.filter(table => table !== 'course_videos')) {
    assert.deepEqual(after[table], before[table])
  }
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('course-video UPDATE rejects pair collisions independently of order and preserves existing links', { timeout: 10000 }, t => {
  const { database, courseId, videoId, secondCourseId, secondVideoId } = setup(t)
  const insert = database.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)')
  insert.run(secondCourseId, videoId, 1)
  insert.run(courseId, secondVideoId, 2)
  insert.run(secondCourseId, secondVideoId, 2)
  const update = database.prepare(
    'UPDATE course_videos SET course_id = ?, video_id = ?, sort_order = ? WHERE course_id = ? AND video_id = ?'
  )
  const sources = [[secondCourseId, videoId], [courseId, secondVideoId], [secondCourseId, secondVideoId]]

  for (const source of sources) {
    assert.equal(database.prepare('SELECT count(*) AS count FROM course_videos WHERE course_id = ? AND video_id = ?')
      .get(...source).count, 1)
    assertPairRejected(database, courseId, 99, () => update.run(courseId, videoId, 99, ...source))
  }

  const beforeSelfUpdate = snapshotRows(database)
  assert.equal(update.run(courseId, videoId, 1, courseId, videoId).changes, 1)
  assert.deepEqual(snapshotRows(database), beforeSelfUpdate)

  const thirdVideoId = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Third video', '/uploads/videos/test-only-third.mp4').lastInsertRowid
  const beforeMove = snapshotRows(database)
  // Only the conflicting target video differs from the rejected UPDATE.
  assert.equal(update.run(courseId, thirdVideoId, 99, secondCourseId, secondVideoId).changes, 1)
  const afterMove = snapshotRows(database)
  for (const table of snapshotTables.filter(table => table !== 'course_videos')) {
    assert.deepEqual(afterMove[table], beforeMove[table])
  }
  assert.deepEqual(readLinks(database), [
    [courseId, videoId, 1], [courseId, secondVideoId, 2], [courseId, thirdVideoId, 99], [secondCourseId, videoId, 1]
  ])
  assert.equal(insert.run(secondCourseId, secondVideoId, 2).changes, 1)
  assert.equal(readLinks(database).length, 5)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('course-video pair uniqueness applies across connections and after reopening with unused orders', { timeout: 10000 }, t => {
  const { context, path, database, courseId, videoId, secondCourseId, secondVideoId } = setup(t)
  database.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)')
    .run(secondCourseId, secondVideoId, 1)
  const before = snapshotRows(database)
  const second = context.open(path)
  assert.deepEqual(snapshotRows(second), before)
  assertPairRejected(second, secondCourseId, 99, () => second.prepare(
    'INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)'
  ).run(secondCourseId, secondVideoId, 99))
  assertPairRejected(second, secondCourseId, 99, () => second.prepare(
    'UPDATE course_videos SET course_id = ?, video_id = ?, sort_order = ? WHERE course_id = ? AND video_id = ?'
  ).run(secondCourseId, secondVideoId, 99, courseId, videoId))
  assert.deepEqual(snapshotRows(database), before)
  database.close()
  second.close()

  const reopened = context.open(path)
  assert.deepEqual(snapshotRows(reopened), before)
  assertPairRejected(reopened, courseId, 99, () => reopened.prepare(
    'INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)'
  ).run(courseId, videoId, 99))
  assert.equal(reopened.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)')
    .run(courseId, secondVideoId, 2).changes, 1)
  assert.deepEqual(readLinks(reopened), [
    [courseId, videoId, 1], [courseId, secondVideoId, 2], [secondCourseId, secondVideoId, 1]
  ])
  assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
})
