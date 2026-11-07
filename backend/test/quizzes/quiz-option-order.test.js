import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadQuiz } from '../../src/db/quiz-queries.js'
import { withTransaction } from '../../src/db/transaction.js'
import { loadVideoQuiz } from '../../src/services/quiz-read.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('shared and public quiz reads preserve every option in explicit sort order', async t => {
  const context = createDatabaseContext(t)
  const path = context.path('quiz-read-option-order.db')
  context.initialize(path)
  const db = context.open(path)
  const fixture = insertMinimalFixture(db)
  const video = db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
  const targetVideo = video.run('Five-option target', 'unused-path').lastInsertRowid
  const controlVideo = video.run('Sparse control', 'unused-path').lastInsertRowid
  const quiz = db.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)')
  const targetQuiz = quiz.run(targetVideo, 'Target question?').lastInsertRowid
  const controlQuiz = quiz.run(controlVideo, 'Control question?').lastInsertRowid
  const target = [
    { id: 90, content: 'Same choice', sortOrder: 1 },
    { id: 12, content: '한글 😀', sortOrder: 2 },
    { id: 70, content: 'Same choice', sortOrder: 3 },
    { id: 6, content: 'Correct choice', sortOrder: 4 },
    { id: 45, content: ' Last choice ', sortOrder: 5 },
  ]
  const control = [
    { id: 88, content: 'Control first', sortOrder: 1 },
    { id: 55, content: 'Control middle', sortOrder: 3 },
    { id: 8, content: 'Control last', sortOrder: 5 },
  ]
  const insert = db.prepare('INSERT INTO quiz_options (id, quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?, ?)')
  // Interleave quizzes and deliberately disagree with both ID and insertion order.
  for (const [quizId, row, correct] of [
    [targetQuiz, target[2], 0], [controlQuiz, control[2], 0], [targetQuiz, target[0], 0],
    [targetQuiz, target[4], 0], [controlQuiz, control[0], 0], [targetQuiz, target[1], 0],
    [controlQuiz, control[1], 1], [targetQuiz, target[3], 1],
  ]) insert.run(row.id, quizId, row.content, row.sortOrder, correct)
  const writer = context.open(path)
  // Reverse scans lacking ORDER BY so index traversal cannot accidentally satisfy the contract.
  db.exec('PRAGMA reverse_unordered_selects = ON')
  db.exec('PRAGMA query_only = ON')
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  })
  const initial = snapshot()
  function assertOptions(videoId, quizId, expected) {
    const before = snapshot()
    for (const read of [
      () => withTransaction(db, connection => loadQuiz(connection, videoId), { mode: 'DEFERRED' }),
      () => loadVideoQuiz(db, { id: videoId }),
    ]) {
      const result = read()
      assert.equal(result.id, quizId)
      assert.equal(result.videoId, videoId)
      assert.deepEqual(result.options.map(({ id, content, sortOrder }) => ({ id, content, sortOrder })), expected)
      assert.equal(result.options.length, expected.length)
      assert.equal(new Set(result.options.map(option => option.id)).size, expected.length)
      assert.equal(db.isTransaction, false)
    }
    assert.deepEqual(snapshot(), before)
  }

  await t.test('all five options follow sortOrder regardless of ID, insertion, correctness, duplicate text or other quizzes', () => {
    assertOptions(targetVideo, targetQuiz, target)
    assertOptions(controlVideo, controlQuiz, control)
    assertOptions(fixture.videoId, fixture.quizId, [
      { id: fixture.correctOptionId, content: 'Correct option', sortOrder: 1 },
      { id: fixture.incorrectOptionId, content: 'Incorrect option', sortOrder: 2 },
    ])
    assert.deepEqual(snapshot(), initial)
  })

  await t.test('fresh reads preserve sparse positions after deletion and place a newly inserted option by order without changing controls', () => {
    writer.prepare('DELETE FROM quiz_options WHERE id = ?').run(target[1].id)
    assertOptions(targetVideo, targetQuiz, target.filter(option => option.sortOrder !== 2))
    assertOptions(controlVideo, controlQuiz, control)
    const replacement = { id: 100, content: 'Replacement middle', sortOrder: 2 }
    writer.prepare('INSERT INTO quiz_options (id, quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?, 0)')
      .run(replacement.id, targetQuiz, replacement.content, replacement.sortOrder)
    assertOptions(targetVideo, targetQuiz, [target[0], replacement, ...target.slice(2)])
    assertOptions(controlVideo, controlQuiz, control)
    const after = snapshot()
    for (const table of tables.filter(table => table !== 'quiz_options' && table !== 'sqlite_sequence')) {
      assert.deepEqual(after.rows[table], initial.rows[table])
    }
    assert.deepEqual(after.rows.quiz_options.filter(row => row.quiz_id !== targetQuiz),
      initial.rows.quiz_options.filter(row => row.quiz_id !== targetQuiz))
    assert.deepEqual(after.schema, initial.schema)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  })
})
