import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('quiz-option-order.db')
  context.initialize(path)
  const database = context.open(path)
  const ids = insertMinimalFixture(database)
  const secondVideoId = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Second video', '/uploads/videos/test-only-second.mp4').lastInsertRowid
  const secondQuizId = database.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)')
    .run(secondVideoId, 'Second question?').lastInsertRowid
  const insert = database.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
  insert.run(secondQuizId, 'Second correct option', 1, 1)
  const secondIncorrectId = insert.run(secondQuizId, 'Second incorrect option', 2, 0).lastInsertRowid
  return { context, path, database, ...ids, secondQuizId, secondIncorrectId }
}

const snapshotTables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function snapshotRows(database) {
  return Object.fromEntries(snapshotTables.map(table => [
    table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))
  ]))
}

function assertOrderRejected(database, quizId, sortOrder, write) {
  assert.equal(database.prepare('SELECT count(*) AS count FROM quiz_options WHERE quiz_id = ? AND sort_order = ?')
    .get(quizId, sortOrder).count, 1)
  const before = snapshotRows(database)
  assert.throws(write, error => {
    // Every candidate is incorrect, so the partial correct-answer index is excluded.
    assert.equal(error.code, 'ERR_SQLITE_ERROR')
    assert.equal(error.errcode, 2067)
    return true
  })
  assert.deepEqual(snapshotRows(database), before)
  assert.equal(database.isTransaction, false)
}

function snapshotWithInsertedOption(before, id, quizId, content, sortOrder) {
  return {
    ...before,
    quiz_options: [...before.quiz_options, { id, quiz_id: quizId, content, sort_order: sortOrder, is_correct: 0 }],
    sqlite_sequence: before.sqlite_sequence.map(row => row.name === 'quiz_options' ? { ...row, seq: id } : row)
  }
}

test('option INSERT rejects occupied positions independently of correctness and permits the same order in another quiz', { timeout: 10000 }, t => {
  const { database, quizId, secondQuizId } = setup(t)
  const before = snapshotRows(database)
  const insert = database.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, 0)')
  const content = 'New incorrect option'
  assertOrderRejected(database, quizId, 1, () => insert.run(quizId, content, 1))
  assertOrderRejected(database, quizId, 2, () => insert.run(quizId, content, 2))
  // Only the occupied order differs from the rejected INSERT.
  const first = insert.run(quizId, content, 3)
  assert.equal(first.changes, 1)
  const afterFirst = snapshotWithInsertedOption(before, first.lastInsertRowid, quizId, content, 3)
  assert.deepEqual(snapshotRows(database), afterFirst)
  const second = insert.run(secondQuizId, content, 3)
  assert.equal(second.changes, 1)
  const afterSecond = snapshotWithInsertedOption(afterFirst, second.lastInsertRowid, secondQuizId, content, 3)
  assert.deepEqual(snapshotRows(database), afterSecond)
  assertOrderRejected(database, secondQuizId, 3, () => insert.run(secondQuizId, 'Different content', 3))
  assert.deepEqual(database.prepare('SELECT quiz_id, count(*) AS count FROM quiz_options GROUP BY quiz_id ORDER BY quiz_id')
    .all().map(row => [row.quiz_id, row.count]), [[quizId, 3], [secondQuizId, 3]])
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('option UPDATE rejects conflicting orders and quiz moves while preserving content and flags', { timeout: 10000 }, t => {
  const { database, quizId, incorrectOptionId, secondIncorrectId } = setup(t)
  const before = snapshotRows(database)
  const update = database.prepare('UPDATE quiz_options SET quiz_id = ?, sort_order = ?, content = ?, is_correct = 0 WHERE id = ?')
  const content = 'Changed incorrect option'
  for (const [id, order] of [[incorrectOptionId, 1], [secondIncorrectId, 2], [secondIncorrectId, 1]]) {
    const source = database.prepare('SELECT * FROM quiz_options WHERE id = ?').get(id)
    assert.ok(source)
    assert.equal(source.is_correct, 0)
    assert.notEqual(database.prepare('SELECT id FROM quiz_options WHERE quiz_id = ? AND sort_order = ?')
      .get(quizId, order).id, id)
    assertOrderRejected(database, quizId, order, () => update.run(quizId, order, content, id))
  }

  const original = before.quiz_options.find(row => row.id === incorrectOptionId)
  assert.equal(update.run(quizId, original.sort_order, original.content, incorrectOptionId).changes, 1)
  assert.deepEqual(snapshotRows(database), before)
  // Only the order changes from the last rejected quiz move.
  assert.equal(update.run(quizId, 3, content, secondIncorrectId).changes, 1)
  const moved = { ...before, quiz_options: before.quiz_options.map(row => row.id === secondIncorrectId
    ? { ...row, quiz_id: quizId, sort_order: 3, content } : row) }
  assert.deepEqual(snapshotRows(database), moved)
  const previousQuizId = before.quiz_options.find(row => row.id === secondIncorrectId).quiz_id
  const replacement = database.prepare(
    'INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, 0)'
  ).run(previousQuizId, 'Replacement incorrect option', 2)
  assert.equal(replacement.changes, 1)
  assert.deepEqual(snapshotRows(database), snapshotWithInsertedOption(
    moved, replacement.lastInsertRowid, previousQuizId, 'Replacement incorrect option', 2
  ))
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('option order uniqueness and existing option rows persist across connections and reopening', { timeout: 10000 }, t => {
  const { context, path, database, quizId, secondQuizId, secondIncorrectId } = setup(t)
  const before = snapshotRows(database)
  const second = context.open(path)
  assert.deepEqual(snapshotRows(second), before)
  assertOrderRejected(second, secondQuizId, 1, () => second.prepare(
    'INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, 0)'
  ).run(secondQuizId, 'Duplicate position', 1))
  assertOrderRejected(second, quizId, 2, () => second.prepare(
    'UPDATE quiz_options SET quiz_id = ?, content = ?, is_correct = 0 WHERE id = ?'
  ).run(quizId, 'Changed content', secondIncorrectId))
  assert.deepEqual(snapshotRows(database), before)
  database.close()
  second.close()

  const reopened = context.open(path)
  assert.deepEqual(snapshotRows(reopened), before)
  const insert = reopened.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, 0)')
  const content = 'New incorrect option'
  assertOrderRejected(reopened, quizId, 2, () => insert.run(quizId, content, 2))
  const result = insert.run(quizId, content, 3)
  assert.equal(result.changes, 1)
  assert.deepEqual(snapshotRows(reopened), snapshotWithInsertedOption(before, result.lastInsertRowid, quizId, content, 3))
  assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
})
