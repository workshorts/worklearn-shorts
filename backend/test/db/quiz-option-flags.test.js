import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const invalidFlags = [-1, 2, 0.5, 1.5, 'true', 'false', '', 'invalid', '0.5', '2',
  new Uint8Array([0]), new Uint8Array([1])]

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('quiz-option-flags.db')
  context.initialize(path)
  const database = context.open(path)
  const ids = insertMinimalFixture(database)
  const videoId = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Second video', '/uploads/videos/test-only-second.mp4').lastInsertRowid
  const secondQuizId = database.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)')
    .run(videoId, 'Second question?').lastInsertRowid
  return { context, path, database, ...ids, secondQuizId }
}

const snapshotTables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function snapshotRows(database) {
  return Object.fromEntries(snapshotTables.map(table => [
    table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))
  ]))
}

function assertRejected(database, errorCode, write) {
  const before = snapshotRows(database)
  assert.throws(write, error => {
    // Distinguish CHECK and NOT NULL errors from unrelated uniqueness failures.
    assert.equal(error.code, 'ERR_SQLITE_ERROR')
    assert.equal(error.errcode, errorCode)
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

test('option flag INSERT rejects values outside zero and one, rejects NULL and accepts valid values and the default', { timeout: 10000 }, t => {
  const { database, secondQuizId } = setup(t)
  const insert = database.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
  const content = 'Flag control option'
  assert.equal(database.prepare('SELECT count(*) AS count FROM quiz_options WHERE quiz_id = ?')
    .get(secondQuizId).count, 0)
  for (const flag of invalidFlags) {
    assertRejected(database, 275, () => insert.run(secondQuizId, content, 1, flag))
  }
  assertRejected(database, 1299, () => insert.run(secondQuizId, content, 1, null))

  const before = snapshotRows(database)
  // Change only the rejected flag to zero, leaving the parent, content and order intact.
  const zero = insert.run(secondQuizId, content, 1, 0)
  assert.equal(zero.changes, 1)
  const afterZero = withInsertedOption(before, zero.lastInsertRowid, secondQuizId, content, 1, 0)
  assert.deepEqual(snapshotRows(database), afterZero)
  const one = insert.run(secondQuizId, content, 2, 1)
  assert.equal(one.changes, 1)
  const afterOne = withInsertedOption(afterZero, one.lastInsertRowid, secondQuizId, content, 2, 1)
  assert.deepEqual(snapshotRows(database), afterOne)
  const omitted = database.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order) VALUES (?, ?, ?)')
    .run(secondQuizId, content, 3)
  assert.equal(omitted.changes, 1)
  assert.deepEqual(snapshotRows(database), withInsertedOption(afterOne, omitted.lastInsertRowid, secondQuizId, content, 3, 0))
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('invalid flag UPDATE preserves the entire option and allows zero and one when no other correct answer exists', { timeout: 10000 }, t => {
  const { database, secondQuizId } = setup(t)
  const optionId = database.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
    .run(secondQuizId, 'Original content', 1, 0).lastInsertRowid
  assert.equal(database.prepare('SELECT count(*) AS count FROM quiz_options WHERE quiz_id = ? AND is_correct = 1')
    .get(secondQuizId).count, 0)
  const update = database.prepare('UPDATE quiz_options SET content = ?, is_correct = ? WHERE id = ?')
  const content = 'Changed content'
  for (const flag of invalidFlags) {
    assertRejected(database, 275, () => update.run(content, flag, optionId))
  }
  assertRejected(database, 1299, () => update.run(content, null, optionId))
  const before = snapshotRows(database)
  assert.equal(update.run('Original content', 0, optionId).changes, 1)
  assert.deepEqual(snapshotRows(database), before)

  for (const flag of [0, 1, 0]) {
    assert.equal(update.run(content, flag, optionId).changes, 1)
    assert.deepEqual(snapshotRows(database), {
      ...before, quiz_options: before.quiz_options.map(row => row.id === optionId
        ? { ...row, content, is_correct: flag } : row)
    })
  }
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('flag validation persists across connections and reopening with SQLite numeric affinity preserved', { timeout: 10000 }, t => {
  const { context, path, database, secondQuizId } = setup(t)
  const optionId = database.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
    .run(secondQuizId, 'Original content', 1, 0).lastInsertRowid
  const before = snapshotRows(database)
  const second = context.open(path)
  assert.deepEqual(snapshotRows(second), before)
  assertRejected(second, 275, () => second.prepare(
    'INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)'
  ).run(secondQuizId, 'Invalid flag', 2, -1))
  assertRejected(second, 275, () => second.prepare('UPDATE quiz_options SET is_correct = ? WHERE id = ?')
    .run(2, optionId))
  assert.deepEqual(snapshotRows(database), before)
  database.close()
  second.close()

  const reopened = context.open(path)
  assert.deepEqual(snapshotRows(reopened), before)
  const insert = reopened.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
  assertRejected(reopened, 1299, () => insert.run(secondQuizId, 'Invalid flag', 2, null))
  let expected = before
  // INTEGER affinity accepts numeric strings; HTTP boolean validation remains separate.
  for (const [input, flag, order] of [['1', 1, 2], ['0', 0, 3]]) {
    const result = insert.run(secondQuizId, 'Numeric flag', order, input)
    assert.equal(result.changes, 1)
    expected = withInsertedOption(expected, result.lastInsertRowid, secondQuizId, 'Numeric flag', order, flag)
    assert.deepEqual(snapshotRows(reopened), expected)
    const stored = reopened.prepare('SELECT is_correct, typeof(is_correct) AS storage_type FROM quiz_options WHERE id = ?')
      .get(result.lastInsertRowid)
    assert.deepEqual({ ...stored }, { is_correct: flag, storage_type: 'integer' })
  }
  assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
})
