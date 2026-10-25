import assert from 'node:assert/strict'
import test from 'node:test'
import { withTransaction } from '../../src/db/transaction.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('quiz-correct-answer.db')
  context.initialize(path)
  const database = context.open(path)
  const ids = insertMinimalFixture(database)
  const insertVideo = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
  const insertQuiz = database.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)')
  const secondVideoId = insertVideo.run('Second video', '/uploads/videos/test-only-second.mp4').lastInsertRowid
  const secondQuizId = insertQuiz.run(secondVideoId, 'Second question?').lastInsertRowid
  const thirdVideoId = insertVideo.run('Third video', '/uploads/videos/test-only-third.mp4').lastInsertRowid
  const thirdQuizId = insertQuiz.run(thirdVideoId, 'Third question?').lastInsertRowid
  const insert = database.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
  const secondCorrectId = insert.run(secondQuizId, 'Second correct option', 1, 1).lastInsertRowid
  insert.run(secondQuizId, 'Second incorrect option', 2, 0)
  return { context, path, database, ...ids, secondQuizId, thirdQuizId, secondCorrectId }
}

const snapshotTables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function snapshotRows(database) {
  return Object.fromEntries(snapshotTables.map(table => [
    table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))
  ]))
}

function assertCorrectRejected(database, quizId, sortOrder, sourceId, write) {
  const correct = database.prepare('SELECT id FROM quiz_options WHERE quiz_id = ? AND is_correct = 1').all(quizId)
  assert.equal(correct.length, 1)
  assert.notEqual(correct[0].id, sourceId)
  const occupied = database.prepare('SELECT id FROM quiz_options WHERE quiz_id = ? AND sort_order = ?')
    .get(quizId, sortOrder)
  // Only an unchanged source position may be occupied; another row cannot mask the partial index.
  assert.ok(occupied === undefined || occupied.id === sourceId)
  const before = snapshotRows(database)
  assert.throws(write, error => {
    assert.equal(error.code, 'ERR_SQLITE_ERROR')
    assert.equal(error.errcode, 2067)
    return true
  })
  assert.deepEqual(snapshotRows(database), before)
  assert.equal(database.isTransaction, false)
}

function withInsertedOption(before, id, quizId, content, sortOrder, flag) {
  return {
    ...before,
    quiz_options: [...before.quiz_options, { id, quiz_id: quizId, content, sort_order: sortOrder, is_correct: flag }],
    sqlite_sequence: before.sqlite_sequence.map(row => row.name === 'quiz_options' ? { ...row, seq: id } : row)
  }
}

test('a second correct INSERT is rejected at a free order while multiple incorrect options and other quizzes remain valid', { timeout: 10000 }, t => {
  const { database, quizId, secondQuizId, thirdQuizId } = setup(t)
  const before = snapshotRows(database)
  const insert = database.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
  const content = 'Candidate option'
  assertCorrectRejected(database, quizId, 3, undefined, () => insert.run(quizId, content, 3, 1))
  assertCorrectRejected(database, secondQuizId, 3, undefined, () => insert.run(secondQuizId, content, 3, 1))
  assert.equal(database.prepare('SELECT count(*) AS count FROM quiz_options WHERE quiz_id = ?')
    .get(thirdQuizId).count, 0)
  // Changing only the parent quiz makes the same correct option valid.
  const first = insert.run(thirdQuizId, content, 3, 1)
  assert.equal(first.changes, 1)
  let expected = withInsertedOption(before, first.lastInsertRowid, thirdQuizId, content, 3, 1)
  assert.deepEqual(snapshotRows(database), expected)
  for (const order of [3, 4]) {
    const result = insert.run(quizId, content, order, 0)
    assert.equal(result.changes, 1)
    expected = withInsertedOption(expected, result.lastInsertRowid, quizId, content, order, 0)
    assert.deepEqual(snapshotRows(database), expected)
  }
  assert.deepEqual(database.prepare('SELECT quiz_id, count(*) AS count FROM quiz_options WHERE is_correct = 1 GROUP BY quiz_id ORDER BY quiz_id')
    .all().map(row => [row.quiz_id, row.count]), [[quizId, 1], [secondQuizId, 1], [thirdQuizId, 1]])
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('promoting an incorrect option or moving another correct option into an occupied quiz preserves all original rows', { timeout: 10000 }, t => {
  const { database, quizId, correctOptionId, incorrectOptionId, secondCorrectId } = setup(t)
  const before = snapshotRows(database)
  const update = database.prepare('UPDATE quiz_options SET quiz_id = ?, content = ?, sort_order = ?, is_correct = ? WHERE id = ?')
  const content = 'Changed candidate'
  assert.equal(database.prepare('SELECT is_correct FROM quiz_options WHERE id = ?').get(incorrectOptionId).is_correct, 0)
  assertCorrectRejected(database, quizId, 2, incorrectOptionId, () => update.run(quizId, content, 2, 1, incorrectOptionId))
  assert.equal(database.prepare('SELECT is_correct FROM quiz_options WHERE id = ?').get(secondCorrectId).is_correct, 1)
  assertCorrectRejected(database, quizId, 3, secondCorrectId, () => update.run(quizId, content, 3, 1, secondCorrectId))
  assert.equal(database.prepare('UPDATE quiz_options SET is_correct = 1 WHERE id = ?').run(correctOptionId).changes, 1)
  assert.deepEqual(snapshotRows(database), before)
  // Changing only correctness removes the collision without changing the destination.
  assert.equal(update.run(quizId, content, 3, 0, secondCorrectId).changes, 1)
  assert.deepEqual(snapshotRows(database), {
    ...before, quiz_options: before.quiz_options.map(row => row.id === secondCorrectId
      ? { ...row, quiz_id: quizId, content, sort_order: 3, is_correct: 0 } : row)
  })
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('releasing the old correct flag before promoting a replacement succeeds in a shared transaction', { timeout: 10000 }, t => {
  const { database, quizId, secondQuizId, correctOptionId, incorrectOptionId } = setup(t)
  const before = snapshotRows(database)
  withTransaction(database, connection => {
    const update = connection.prepare('UPDATE quiz_options SET is_correct = ? WHERE id = ?')
    assert.equal(update.run(0, correctOptionId).changes, 1)
    assert.equal(update.run(1, incorrectOptionId).changes, 1)
  })
  assert.equal(database.isTransaction, false)
  assert.deepEqual(snapshotRows(database), {
    ...before, quiz_options: before.quiz_options.map(row => row.id === correctOptionId
      ? { ...row, is_correct: 0 } : row.id === incorrectOptionId ? { ...row, is_correct: 1 } : row)
  })
  assert.deepEqual(database.prepare('SELECT quiz_id, count(*) AS count FROM quiz_options WHERE is_correct = 1 GROUP BY quiz_id ORDER BY quiz_id')
    .all().map(row => [row.quiz_id, row.count]), [[quizId, 1], [secondQuizId, 1]])
  assertCorrectRejected(database, quizId, 1, correctOptionId, () => database.prepare(
    'UPDATE quiz_options SET is_correct = 1 WHERE id = ?'
  ).run(correctOptionId))
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('one-correct-answer enforcement persists across connections and reopening without relying on order collisions', { timeout: 10000 }, t => {
  const { context, path, database, quizId, incorrectOptionId } = setup(t)
  const before = snapshotRows(database)
  const second = context.open(path)
  assert.deepEqual(snapshotRows(second), before)
  assertCorrectRejected(second, quizId, 3, undefined, () => second.prepare(
    'INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)'
  ).run(quizId, 'New candidate', 3, 1))
  assertCorrectRejected(second, quizId, 2, incorrectOptionId, () => second.prepare(
    'UPDATE quiz_options SET content = ?, is_correct = 1 WHERE id = ?'
  ).run('Changed candidate', incorrectOptionId))
  assert.deepEqual(snapshotRows(database), before)
  database.close()
  second.close()

  const reopened = context.open(path)
  assert.deepEqual(snapshotRows(reopened), before)
  const insert = reopened.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
  assertCorrectRejected(reopened, quizId, 3, undefined, () => insert.run(quizId, 'New candidate', 3, 1))
  const result = insert.run(quizId, 'New candidate', 3, 0)
  assert.equal(result.changes, 1)
  assert.deepEqual(snapshotRows(reopened), withInsertedOption(before, result.lastInsertRowid, quizId, 'New candidate', 3, 0))
  assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
})
