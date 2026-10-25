import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('video-deletion.db')
  context.initialize(path)
  const database = context.open(path)
  assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  const ids = insertMinimalFixture(database)
  const insertVideo = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
  const secondVideoId = insertVideo.run('Retained video', '/uploads/videos/test-only-retained.mp4').lastInsertRowid
  const bareVideoId = insertVideo.run('Bare video', '/uploads/videos/test-only-bare.mp4').lastInsertRowid
  const secondTagId = database.prepare('INSERT INTO tags (name) VALUES (?)').run('Shared second tag').lastInsertRowid
  const secondCourseId = database.prepare('INSERT INTO courses (name) VALUES (?)').run('Shared second course').lastInsertRowid
  const insertTagLink = database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
  insertTagLink.run(ids.videoId, secondTagId)
  insertTagLink.run(secondVideoId, ids.tagId)
  insertTagLink.run(secondVideoId, secondTagId)
  const insertCourseLink = database.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)')
  insertCourseLink.run(ids.courseId, secondVideoId, 2)
  insertCourseLink.run(secondCourseId, ids.videoId, 2)
  insertCourseLink.run(secondCourseId, secondVideoId, 1)

  const secondVisitorId = '00000000-0000-4000-8000-000000000002'
  for (const table of ['video_views', 'video_likes']) {
    const insert = database.prepare(`INSERT INTO ${table} (video_id, visitor_id) VALUES (?, ?)`)
    insert.run(ids.videoId, secondVisitorId)
    insert.run(secondVideoId, ids.visitorId)
    insert.run(secondVideoId, secondVisitorId)
  }
  const insertComment = database.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)')
  // Placeholder hashes belong only to DB tests, never real authentication.
  insertComment.run(ids.videoId, 'Test user', 'test-only-placeholder', 'Second target comment')
  insertComment.run(secondVideoId, 'Test user', 'test-only-placeholder', 'First retained comment')
  insertComment.run(secondVideoId, 'Test user', 'test-only-placeholder', 'Second retained comment')
  const secondQuizId = database.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)')
    .run(secondVideoId, 'Retained question?').lastInsertRowid
  const insertOption = database.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
  insertOption.run(secondQuizId, 'Retained correct option', 1, 1)
  insertOption.run(secondQuizId, 'Retained incorrect option', 2, 0)
  return { context, path, database, ...ids, secondVideoId, secondQuizId, bareVideoId }
}

const videoChildTables = ['course_videos', 'video_tags', 'video_views', 'video_likes', 'comments', 'quizzes']
const snapshotTables = ['admins', 'videos', 'tags', 'courses', ...videoChildTables, 'quiz_options', 'sqlite_sequence']

function snapshotRows(database) {
  return Object.fromEntries(snapshotTables.map(table => [
    table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))
  ]))
}

function withoutVideo(before, videoId) {
  const quizIds = new Set(before.quizzes.filter(row => row.video_id === videoId).map(row => row.id))
  return {
    ...before,
    videos: before.videos.filter(row => row.id !== videoId),
    ...Object.fromEntries(videoChildTables.map(table => [table, before[table].filter(row => row.video_id !== videoId)])),
    quiz_options: before.quiz_options.filter(row => !quizIds.has(row.quiz_id))
  }
}

test('video deletion cascades through all related rows and quiz options while preserving other videos and shared parents', { timeout: 10000 }, t => {
  const { database, videoId, quizId, secondVideoId, secondQuizId } = setup(t)
  const before = snapshotRows(database)
  for (const table of videoChildTables) {
    const count = table === 'quizzes' ? 1 : 2
    assert.equal(before[table].filter(row => row.video_id === videoId).length, count)
    assert.equal(before[table].filter(row => row.video_id === secondVideoId).length, count)
  }
  assert.equal(before.quiz_options.filter(row => row.quiz_id === quizId).length, 2)
  assert.equal(before.quiz_options.filter(row => row.quiz_id === secondQuizId).length, 2)
  assert.equal(before.tags.length, 2)
  assert.equal(before.courses.length, 2)
  const remove = database.prepare('DELETE FROM videos WHERE id = ?')
  // Parent changes exclude cascades; compare every affected table independently.
  assert.equal(remove.run(videoId).changes, 1)
  const expected = withoutVideo(before, videoId)
  assert.deepEqual(snapshotRows(database), expected)
  assert.equal(remove.run(videoId).changes, 0)
  assert.deepEqual(snapshotRows(database), expected)
  assert.equal(database.isTransaction, false)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('deleting a video without dependents or an absent video preserves all populated relationships', { timeout: 10000 }, t => {
  const { database, bareVideoId } = setup(t)
  const before = snapshotRows(database)
  assert.equal(before.videos.filter(row => row.id === bareVideoId).length, 1)
  for (const table of videoChildTables) {
    assert.equal(before[table].filter(row => row.video_id === bareVideoId).length, 0)
  }
  const remove = database.prepare('DELETE FROM videos WHERE id = ?')
  assert.equal(remove.run(bareVideoId).changes, 1)
  const expected = withoutVideo(before, bareVideoId)
  assert.deepEqual(snapshotRows(database), expected)
  const missingId = 999999
  assert.equal(database.prepare('SELECT id FROM videos WHERE id = ?').get(missingId), undefined)
  assert.equal(remove.run(missingId).changes, 0)
  assert.deepEqual(snapshotRows(database), expected)
  assert.equal(database.isTransaction, false)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('video cascades persist across connections and reopening and a new video inherits no old records', { timeout: 10000 }, t => {
  const { context, path, database, videoId } = setup(t)
  const before = snapshotRows(database)
  const original = before.videos.find(row => row.id === videoId)
  const expected = withoutVideo(before, videoId)
  const second = context.open(path)
  assert.deepEqual(snapshotRows(second), before)
  assert.equal(second.prepare('DELETE FROM videos WHERE id = ?').run(videoId).changes, 1)
  assert.deepEqual(snapshotRows(second), expected)
  assert.deepEqual(snapshotRows(database), expected)
  database.close()
  second.close()

  const reopened = context.open(path)
  assert.deepEqual(snapshotRows(reopened), expected)
  assert.equal(reopened.prepare('DELETE FROM videos WHERE id = ?').run(videoId).changes, 0)
  assert.deepEqual(snapshotRows(reopened), expected)
  const time = '2001-02-03T04:05:06.007Z'
  const result = reopened.prepare('INSERT INTO videos (title, video_path, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(original.title, original.video_path, time, time)
  assert.equal(result.changes, 1)
  assert.ok(result.lastInsertRowid > Math.max(...before.videos.map(row => row.id)))
  // Reusing display and path values must not restore any deleted associations.
  assert.deepEqual(snapshotRows(reopened), {
    ...expected,
    videos: [...expected.videos, { id: result.lastInsertRowid, title: original.title,
      description: '', video_path: original.video_path, thumbnail_path: null, created_at: time, updated_at: time }],
    sqlite_sequence: expected.sqlite_sequence.map(row => row.name === 'videos'
      ? { ...row, seq: result.lastInsertRowid } : row)
  })
  assert.equal(reopened.isTransaction, false)
  assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
})
