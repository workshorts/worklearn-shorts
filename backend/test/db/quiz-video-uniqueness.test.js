import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const controlTime = '2001-02-03T04:05:06.007Z'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('quiz-video-uniqueness.db')
  context.initialize(path)
  const database = context.open(path)
  const ids = insertMinimalFixture(database)
  const insertVideo = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
  const secondVideoId = insertVideo.run('Second video', '/uploads/videos/test-only-second.mp4').lastInsertRowid
  const thirdVideoId = insertVideo.run('Third video', '/uploads/videos/test-only-third.mp4').lastInsertRowid
  return { context, path, database, ...ids, secondVideoId, thirdVideoId }
}

function insertQuizWithOptions(database, videoId) {
  const quizId = database.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)')
    .run(videoId, 'Second question?').lastInsertRowid
  const insert = database.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
  insert.run(quizId, 'Second correct option', 1, 1)
  insert.run(quizId, 'Second incorrect option', 2, 0)
  return quizId
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
    // Require video_id uniqueness, not a primary-key or foreign-key failure.
    assert.equal(error.code, 'ERR_SQLITE_ERROR')
    assert.equal(error.errcode, 2067)
    return true
  })
  assert.deepEqual(snapshotRows(database), before)
  assert.equal(database.isTransaction, false)
}

test('quiz INSERT rejects a second question for one video while allowing the same question on another video', { timeout: 10000 }, t => {
  const { database, videoId, quizId, secondVideoId } = setup(t)
  const original = database.prepare('SELECT * FROM quizzes WHERE id = ?').get(quizId)
  const before = snapshotRows(database)
  const insert = database.prepare(
    'INSERT INTO quizzes (video_id, question, created_at, updated_at) VALUES (?, ?, ?, ?)'
  )
  assertRejected(database, () => database.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)')
    .run(videoId, 'Different question?'))
  assertRejected(database, () => insert.run(videoId, original.question, controlTime, controlTime))
  // Only the video differs from the rejected INSERT; identical questions are valid.
  const result = insert.run(secondVideoId, original.question, controlTime, controlTime)
  assert.equal(result.changes, 1)
  assert.notEqual(result.lastInsertRowid, quizId)
  const expected = { id: result.lastInsertRowid, video_id: secondVideoId,
    question: original.question, created_at: controlTime, updated_at: controlTime }
  assert.deepEqual({ ...database.prepare('SELECT * FROM quizzes WHERE id = ?').get(result.lastInsertRowid) }, expected)
  assert.deepEqual(database.prepare('SELECT * FROM quizzes WHERE id = ?').get(quizId), original)
  assert.deepEqual(database.prepare('SELECT video_id, count(*) AS count FROM quizzes GROUP BY video_id ORDER BY video_id')
    .all().map(row => [row.video_id, row.count]), [[videoId, 1], [secondVideoId, 1]])
  const after = snapshotRows(database)
  for (const table of snapshotTables.filter(table => !['quizzes', 'sqlite_sequence'].includes(table))) {
    assert.deepEqual(after[table], before[table])
  }
  assert.deepEqual(after.sqlite_sequence.map(row => ({ ...row })), before.sqlite_sequence.map(row =>
    row.name === 'quizzes' ? { ...row, seq: result.lastInsertRowid } : { ...row }))
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('quiz UPDATE rejects an occupied video and preserves both quizzes and their options', { timeout: 10000 }, t => {
  const { database, videoId, quizId, secondVideoId, thirdVideoId } = setup(t)
  const secondQuizId = insertQuizWithOptions(database, secondVideoId)
  const secondQuiz = database.prepare('SELECT * FROM quizzes WHERE id = ?').get(secondQuizId)
  const before = snapshotRows(database)
  const update = database.prepare('UPDATE quizzes SET video_id = ?, question = ?, updated_at = ? WHERE id = ?')
  assertRejected(database, () => update.run(videoId, 'Changed question?', controlTime, secondQuizId))

  assert.equal(database.prepare('UPDATE quizzes SET video_id = ? WHERE id = ?')
    .run(secondVideoId, secondQuizId).changes, 1)
  assert.deepEqual(snapshotRows(database), before)
  // Only the target video differs from the rejected UPDATE.
  assert.equal(update.run(thirdVideoId, 'Changed question?', controlTime, secondQuizId).changes, 1)
  assert.deepEqual({ ...database.prepare('SELECT * FROM quizzes WHERE id = ?').get(secondQuizId) },
    { ...secondQuiz, video_id: thirdVideoId, question: 'Changed question?', updated_at: controlTime })
  assert.deepEqual(database.prepare('SELECT * FROM quizzes WHERE id = ?').get(quizId),
    before.quizzes.find(row => row.id === quizId))
  const after = snapshotRows(database)
  for (const table of snapshotTables.filter(table => table !== 'quizzes')) {
    assert.deepEqual(after[table], before[table])
  }
  assert.equal(database.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)')
    .run(secondVideoId, 'Replacement question?').changes, 1)
  assert.equal(database.prepare('SELECT count(*) AS count FROM quizzes').get().count, 3)
  assert.deepEqual(snapshotRows(database).quiz_options, before.quiz_options)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('one-quiz-per-video enforcement and existing options persist across connections and reopening', { timeout: 10000 }, t => {
  const { context, path, database, videoId, secondVideoId, thirdVideoId } = setup(t)
  const secondQuizId = insertQuizWithOptions(database, secondVideoId)
  const before = snapshotRows(database)
  const second = context.open(path)
  assert.deepEqual(snapshotRows(second), before)
  assertRejected(second, () => second.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)')
    .run(secondVideoId, 'Another question?'))
  assertRejected(second, () => second.prepare('UPDATE quizzes SET video_id = ?, question = ? WHERE id = ?')
    .run(videoId, 'Changed question?', secondQuizId))
  assert.deepEqual(snapshotRows(database), before)
  database.close()
  second.close()

  const reopened = context.open(path)
  assert.deepEqual(snapshotRows(reopened), before)
  assertRejected(reopened, () => reopened.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)')
    .run(videoId, 'Another question?'))
  assert.equal(reopened.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)')
    .run(thirdVideoId, 'Another question?').changes, 1)
  assert.deepEqual(reopened.prepare('SELECT video_id, count(*) AS count FROM quizzes GROUP BY video_id ORDER BY video_id')
    .all().map(row => [row.video_id, row.count]), [[videoId, 1], [secondVideoId, 1], [thirdVideoId, 1]])
  assert.deepEqual(snapshotRows(reopened).quiz_options, before.quiz_options)
  assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
})
