import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('course-deletion.db')
  context.initialize(path)
  const database = context.open(path)
  assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  const ids = insertMinimalFixture(database)
  const secondVideoId = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Second video', '/uploads/videos/test-only-second.mp4').lastInsertRowid
  const insertCourse = database.prepare('INSERT INTO courses (name) VALUES (?)')
  const otherCourseId = insertCourse.run('Retained course').lastInsertRowid
  const emptyCourseId = insertCourse.run('Empty course').lastInsertRowid
  const link = database.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)')
  link.run(ids.courseId, secondVideoId, 2)
  link.run(otherCourseId, ids.videoId, 2)
  link.run(otherCourseId, secondVideoId, 1)
  return { context, path, database, ...ids, secondVideoId, otherCourseId, emptyCourseId }
}

const snapshotTables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function snapshotRows(database) {
  return Object.fromEntries(snapshotTables.map(table => [
    table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))
  ]))
}

function withoutCourse(before, courseId) {
  return {
    ...before,
    courses: before.courses.filter(row => row.id !== courseId),
    course_videos: before.course_videos.filter(row => row.course_id !== courseId)
  }
}

test('deleting a course removes only its links and preserves original videos and other course ordering', { timeout: 10000 }, t => {
  const { database, courseId, otherCourseId, videoId, secondVideoId } = setup(t)
  const before = snapshotRows(database)
  assert.equal(before.courses.filter(row => row.id === courseId).length, 1)
  assert.equal(before.course_videos.filter(row => row.course_id === courseId).length, 2)
  const remove = database.prepare('DELETE FROM courses WHERE id = ?')
  // Parent changes exclude cascaded links; compare actual child rows separately.
  assert.equal(remove.run(courseId).changes, 1)
  const expected = withoutCourse(before, courseId)
  assert.deepEqual(snapshotRows(database), expected)
  assert.deepEqual(database.prepare('SELECT course_id, video_id, sort_order FROM course_videos ORDER BY course_id, sort_order')
    .all().map(row => [row.course_id, row.video_id, row.sort_order]),
  [[otherCourseId, secondVideoId, 1], [otherCourseId, videoId, 2]])
  assert.equal(remove.run(courseId).changes, 0)
  assert.deepEqual(snapshotRows(database), expected)
  assert.equal(database.isTransaction, false)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('deleting an empty course or absent course preserves every existing video and link', { timeout: 10000 }, t => {
  const { database, emptyCourseId } = setup(t)
  const before = snapshotRows(database)
  assert.equal(before.courses.filter(row => row.id === emptyCourseId).length, 1)
  assert.equal(before.course_videos.filter(row => row.course_id === emptyCourseId).length, 0)
  const remove = database.prepare('DELETE FROM courses WHERE id = ?')
  assert.equal(remove.run(emptyCourseId).changes, 1)
  const expected = withoutCourse(before, emptyCourseId)
  assert.deepEqual(snapshotRows(database), expected)
  const missingId = 999999
  assert.equal(database.prepare('SELECT id FROM courses WHERE id = ?').get(missingId), undefined)
  assert.equal(remove.run(missingId).changes, 0)
  assert.deepEqual(snapshotRows(database), expected)
  assert.equal(database.isTransaction, false)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('course deletion persists across connections and reopening and a new course does not inherit old links', { timeout: 10000 }, t => {
  const { context, path, database, courseId } = setup(t)
  const before = snapshotRows(database)
  const expected = withoutCourse(before, courseId)
  const second = context.open(path)
  assert.deepEqual(snapshotRows(second), before)
  assert.equal(second.prepare('DELETE FROM courses WHERE id = ?').run(courseId).changes, 1)
  assert.deepEqual(snapshotRows(second), expected)
  assert.deepEqual(snapshotRows(database), expected)
  database.close()
  second.close()

  const reopened = context.open(path)
  assert.deepEqual(snapshotRows(reopened), expected)
  assert.equal(reopened.prepare('DELETE FROM courses WHERE id = ?').run(courseId).changes, 0)
  assert.deepEqual(snapshotRows(reopened), expected)
  // Reusing a display name creates a new course, never the old connections or order.
  const name = 'Fixture course'
  const time = '2001-02-03T04:05:06.007Z'
  const result = reopened.prepare('INSERT INTO courses (name, created_at, updated_at) VALUES (?, ?, ?)')
    .run(name, time, time)
  assert.equal(result.changes, 1)
  assert.ok(result.lastInsertRowid > Math.max(...before.courses.map(row => row.id)))
  assert.deepEqual(snapshotRows(reopened), {
    ...expected,
    courses: [...expected.courses, { id: result.lastInsertRowid, name, description: '', created_at: time, updated_at: time }],
    sqlite_sequence: expected.sqlite_sequence.map(row => row.name === 'courses'
      ? { ...row, seq: result.lastInsertRowid } : row)
  })
  assert.equal(reopened.isTransaction, false)
  assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
})
