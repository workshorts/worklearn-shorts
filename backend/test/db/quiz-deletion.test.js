import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('quiz-deletion.db')
  context.initialize(path)
  const database = context.open(path)
  assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  const ids = insertMinimalFixture(database)
  const insertVideo = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
  const secondVideoId = insertVideo.run('Retained video', '/uploads/videos/test-only-retained.mp4').lastInsertRowid
  const thirdVideoId = insertVideo.run('Third video', '/uploads/videos/test-only-third.mp4').lastInsertRowid
  database.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)')
    .run(ids.courseId, secondVideoId, 2)
  database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(secondVideoId, ids.tagId)
  for (const table of ['video_views', 'video_likes']) {
    database.prepare(`INSERT INTO ${table} (video_id, visitor_id) VALUES (?, ?)`).run(secondVideoId, ids.visitorId)
  }
  database.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)')
    .run(secondVideoId, 'Test user', 'test-only-placeholder', 'Retained comment')
  const insertQuiz = database.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)')
  const secondQuizId = insertQuiz.run(secondVideoId, 'Retained question?').lastInsertRowid
  const emptyQuizId = insertQuiz.run(thirdVideoId, 'Question without options?').lastInsertRowid
  const insertOption = database.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
  insertOption.run(secondQuizId, 'Retained correct option', 1, 1)
  insertOption.run(secondQuizId, 'Retained incorrect option', 2, 0)
  return { context, path, database, ...ids, secondQuizId, emptyQuizId }
}

const snapshotTables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function snapshotRows(database) {
  return Object.fromEntries(snapshotTables.map(table => [
    table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))
  ]))
}

function withoutQuiz(before, quizId) {
  return {
    ...before,
    quizzes: before.quizzes.filter(row => row.id !== quizId),
    quiz_options: before.quiz_options.filter(row => row.quiz_id !== quizId)
  }
}

test('quiz deletion removes only its options and preserves the source video, other quizzes and all unrelated records', { timeout: 10000 }, t => {
  const { database, videoId, quizId, secondQuizId } = setup(t)
  const before = snapshotRows(database)
  assert.equal(before.quizzes.filter(row => row.id === quizId && row.video_id === videoId).length, 1)
  assert.equal(before.quiz_options.filter(row => row.quiz_id === quizId).length, 2)
  assert.equal(before.quiz_options.filter(row => row.quiz_id === secondQuizId).length, 2)
  const remove = database.prepare('DELETE FROM quizzes WHERE id = ?')
  // Parent changes exclude cascaded options; compare actual child rows separately.
  assert.equal(remove.run(quizId).changes, 1)
  const expected = withoutQuiz(before, quizId)
  assert.deepEqual(snapshotRows(database), expected)
  assert.deepEqual({ ...database.prepare('SELECT * FROM videos WHERE id = ?').get(videoId) },
    before.videos.find(row => row.id === videoId))
  assert.equal(remove.run(quizId).changes, 0)
  assert.deepEqual(snapshotRows(database), expected)
  assert.equal(database.isTransaction, false)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('deleting a quiz without options or an absent quiz preserves videos and every populated relationship', { timeout: 10000 }, t => {
  const { database, emptyQuizId } = setup(t)
  const before = snapshotRows(database)
  assert.equal(before.quizzes.filter(row => row.id === emptyQuizId).length, 1)
  assert.equal(before.quiz_options.filter(row => row.quiz_id === emptyQuizId).length, 0)
  const remove = database.prepare('DELETE FROM quizzes WHERE id = ?')
  assert.equal(remove.run(emptyQuizId).changes, 1)
  const expected = withoutQuiz(before, emptyQuizId)
  assert.deepEqual(snapshotRows(database), expected)
  const missingId = 999999
  assert.equal(database.prepare('SELECT id FROM quizzes WHERE id = ?').get(missingId), undefined)
  assert.equal(remove.run(missingId).changes, 0)
  assert.deepEqual(snapshotRows(database), expected)
  assert.equal(database.isTransaction, false)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('quiz cascades persist across connections and reopening and replacement quizzes inherit no old options', { timeout: 10000 }, t => {
  const { context, path, database, videoId, quizId } = setup(t)
  const before = snapshotRows(database)
  const original = before.quizzes.find(row => row.id === quizId)
  const expected = withoutQuiz(before, quizId)
  const second = context.open(path)
  assert.deepEqual(snapshotRows(second), before)
  assert.equal(second.prepare('DELETE FROM quizzes WHERE id = ?').run(quizId).changes, 1)
  assert.deepEqual(snapshotRows(second), expected)
  assert.deepEqual(snapshotRows(database), expected)
  database.close()
  second.close()

  const reopened = context.open(path)
  assert.deepEqual(snapshotRows(reopened), expected)
  assert.equal(reopened.prepare('DELETE FROM quizzes WHERE id = ?').run(quizId).changes, 0)
  assert.deepEqual(snapshotRows(reopened), expected)
  const time = '2001-02-03T04:05:06.007Z'
  const result = reopened.prepare('INSERT INTO quizzes (video_id, question, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(videoId, original.question, time, time)
  assert.equal(result.changes, 1)
  assert.ok(result.lastInsertRowid > Math.max(...before.quizzes.map(row => row.id)))
  // Reusing a video's question must not reconnect options from the deleted quiz.
  assert.deepEqual(snapshotRows(reopened), {
    ...expected,
    quizzes: [...expected.quizzes, { id: result.lastInsertRowid, video_id: videoId,
      question: original.question, created_at: time, updated_at: time }],
    sqlite_sequence: expected.sqlite_sequence.map(row => row.name === 'quizzes'
      ? { ...row, seq: result.lastInsertRowid } : row)
  })
  assert.equal(reopened.isTransaction, false)
  assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
})
