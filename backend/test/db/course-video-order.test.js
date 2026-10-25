import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('course-video-order.db')
  context.initialize(path)
  const database = context.open(path)
  const ids = insertMinimalFixture(database)
  const secondCourseId = database.prepare('INSERT INTO courses (name) VALUES (?)')
    .run('Second course').lastInsertRowid
  const insertVideo = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
  const secondVideoId = insertVideo.run('Second video', '/uploads/videos/test-only-second.mp4').lastInsertRowid
  const thirdVideoId = insertVideo.run('Third video', '/uploads/videos/test-only-third.mp4').lastInsertRowid
  return { context, path, database, ...ids, secondCourseId, secondVideoId, thirdVideoId }
}

const snapshotTables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function snapshotRows(database) {
  return Object.fromEntries(snapshotTables.map(table => [
    table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
  ]))
}

function assertOrderRejected(database, courseId, videoId, sortOrder, write) {
  const occupied = database.prepare('SELECT video_id FROM course_videos WHERE course_id = ? AND sort_order = ?')
    .get(courseId, sortOrder)
  assert.ok(occupied)
  assert.notEqual(occupied.video_id, videoId)
  const before = snapshotRows(database)
  assert.throws(write, error => {
    // A pair collision or missing parent must not substitute for order uniqueness.
    assert.equal(error.code, 'ERR_SQLITE_ERROR')
    assert.equal(error.errcode, 2067)
    return true
  })
  assert.deepEqual(snapshotRows(database), before)
  assert.equal(database.isTransaction, false)
}

function readLinks(database) {
  return database.prepare('SELECT course_id, video_id, sort_order FROM course_videos ORDER BY course_id, sort_order')
    .all().map(row => [row.course_id, row.video_id, row.sort_order])
}

test('course order INSERT rejects a different video at an occupied position but allows reuse in other courses', { timeout: 10000 }, t => {
  const { database, courseId, videoId, secondCourseId, secondVideoId, thirdVideoId } = setup(t)
  const insert = database.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)')
  const before = snapshotRows(database)
  assert.equal(database.prepare('SELECT count(*) AS count FROM course_videos WHERE course_id = ? AND video_id = ?')
    .get(courseId, secondVideoId).count, 0)
  assertOrderRejected(database, courseId, secondVideoId, 1, () => insert.run(courseId, secondVideoId, 1))
  // Only the occupied order differs from the rejected INSERT.
  assert.equal(insert.run(courseId, secondVideoId, 2).changes, 1)
  assertOrderRejected(database, courseId, thirdVideoId, 2, () => insert.run(courseId, thirdVideoId, 2))
  assert.equal(insert.run(secondCourseId, videoId, 1).changes, 1)
  assert.equal(insert.run(secondCourseId, thirdVideoId, 2).changes, 1)
  assert.deepEqual(readLinks(database), [
    [courseId, videoId, 1], [courseId, secondVideoId, 2],
    [secondCourseId, videoId, 1], [secondCourseId, thirdVideoId, 2]
  ])
  const after = snapshotRows(database)
  for (const table of snapshotTables.filter(table => table !== 'course_videos')) {
    assert.deepEqual(after[table], before[table])
  }
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('course order UPDATE rejects conflicting positions and moves while preserving the original sequence', { timeout: 10000 }, t => {
  const { database, courseId, videoId, secondCourseId, secondVideoId, thirdVideoId } = setup(t)
  const insert = database.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)')
  insert.run(courseId, secondVideoId, 2)
  insert.run(secondCourseId, thirdVideoId, 1)
  const update = database.prepare(
    'UPDATE course_videos SET course_id = ?, sort_order = ? WHERE course_id = ? AND video_id = ?'
  )
  const cases = [
    { sourceCourse: courseId, video: secondVideoId, order: 1 },
    { sourceCourse: secondCourseId, video: thirdVideoId, order: 1 },
    { sourceCourse: secondCourseId, video: thirdVideoId, order: 2 }
  ]
  for (const { sourceCourse, video, order } of cases) {
    assert.equal(database.prepare('SELECT count(*) AS count FROM course_videos WHERE course_id = ? AND video_id = ?')
      .get(sourceCourse, video).count, 1)
    // The target pair is either the same source row or does not yet exist.
    assert.equal(database.prepare('SELECT count(*) AS count FROM course_videos WHERE course_id = ? AND video_id = ?')
      .get(courseId, video).count, sourceCourse === courseId ? 1 : 0)
    assertOrderRejected(database, courseId, video, order, () => update.run(courseId, order, sourceCourse, video))
  }

  const before = snapshotRows(database)
  assert.equal(update.run(courseId, 1, courseId, videoId).changes, 1)
  assert.deepEqual(snapshotRows(database), before)
  // Only the order changes from the last rejected move.
  assert.equal(update.run(courseId, 3, secondCourseId, thirdVideoId).changes, 1)
  assert.equal(insert.run(secondCourseId, secondVideoId, 1).changes, 1)
  assert.deepEqual(readLinks(database), [
    [courseId, videoId, 1], [courseId, secondVideoId, 2],
    [courseId, thirdVideoId, 3], [secondCourseId, secondVideoId, 1]
  ])
  const after = snapshotRows(database)
  for (const table of snapshotTables.filter(table => table !== 'course_videos')) {
    assert.deepEqual(after[table], before[table])
  }
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('course order uniqueness applies across connections and after reopening', { timeout: 10000 }, t => {
  const { context, path, database, courseId, videoId, secondCourseId, secondVideoId, thirdVideoId } = setup(t)
  database.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)')
    .run(secondCourseId, secondVideoId, 1)
  const before = snapshotRows(database)
  const second = context.open(path)
  assert.deepEqual(snapshotRows(second), before)
  assertOrderRejected(second, courseId, thirdVideoId, 1, () => second.prepare(
    'INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)'
  ).run(courseId, thirdVideoId, 1))
  assertOrderRejected(second, courseId, secondVideoId, 1, () => second.prepare(
    'UPDATE course_videos SET course_id = ? WHERE course_id = ? AND video_id = ?'
  ).run(courseId, secondCourseId, secondVideoId))
  assert.deepEqual(snapshotRows(database), before)
  database.close()
  second.close()

  const reopened = context.open(path)
  assert.deepEqual(snapshotRows(reopened), before)
  assertOrderRejected(reopened, secondCourseId, thirdVideoId, 1, () => reopened.prepare(
    'INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)'
  ).run(secondCourseId, thirdVideoId, 1))
  assert.equal(reopened.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)')
    .run(secondCourseId, thirdVideoId, 2).changes, 1)
  assert.deepEqual(readLinks(reopened), [
    [courseId, videoId, 1],
    [secondCourseId, secondVideoId, 1], [secondCourseId, thirdVideoId, 2]
  ])
  assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
})
