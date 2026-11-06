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

test('quiz option correctness is boolean through shared reads, public services and JSON serialization', async t => {
  const context = createDatabaseContext(t)
  const path = context.path('quiz-read-option-flags.db')
  context.initialize(path)
  const db = context.open(path)
  const fixture = insertMinimalFixture(db)
  const videoId = db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Boolean target', 'unused-path').lastInsertRowid
  const quizId = db.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)')
    .run(videoId, 'Which option is correct?').lastInsertRowid
  const explicitZero = db.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, 0)')
  const defaultZero = db.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order) VALUES (?, ?, ?)')
  const optionIds = []
  for (let order = 1; order <= 5; order++) {
    const insert = order % 2 === 0 ? explicitZero : defaultZero
    optionIds.push(insert.run(quizId, `Option ${order}`, order).lastInsertRowid)
  }
  db.prepare('UPDATE quiz_options SET is_correct = 1 WHERE id = ?').run(optionIds[2])
  const writer = context.open(path)
  db.exec('PRAGMA query_only = ON')
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table,
      db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row })),
    ])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  })
  const initial = snapshot()
  const control = new Map([[fixture.correctOptionId, true], [fixture.incorrectOptionId, false]])
  function assertFlags(targetVideo, targetQuiz, expected) {
    const before = snapshot()
    const raw = db.prepare('SELECT id, is_correct FROM quiz_options WHERE quiz_id = ? ORDER BY sort_order').all(targetQuiz)
    assert.equal(raw.length, expected.size)
    for (const row of raw) {
      assert.equal(typeof row.is_correct, 'number')
      assert.equal(row.is_correct, expected.get(row.id) ? 1 : 0)
    }
    for (const read of [
      () => withTransaction(db, connection => loadQuiz(connection, targetVideo), { mode: 'DEFERRED' }),
      () => loadVideoQuiz(db, { id: targetVideo }),
    ]) {
      const result = read()
      assert.equal(result.id, targetQuiz)
      assert.equal(result.videoId, targetVideo)
      // Check parsed JSON too: truthy numbers or strings must not masquerade as booleans.
      for (const quiz of [result, JSON.parse(JSON.stringify(result))]) {
        assert.deepEqual(quiz.options.map(option => option.id), [...expected.keys()])
        for (const option of quiz.options) {
          assert.equal(typeof option.isCorrect, 'boolean')
          assert.equal(option.isCorrect, expected.get(option.id))
        }
        assert.equal(quiz.options.filter(option => option.isCorrect === true).length, 1)
      }
      assert.equal(db.isTransaction, false)
    }
    assert.deepEqual(snapshot(), before)
  }

  await t.test('numeric one becomes true while explicit and default zero become false without changing stored flags', () => {
    assertFlags(videoId, quizId, new Map(optionIds.map((id, index) => [id, index === 2])))
    assertFlags(fixture.videoId, fixture.quizId, control)
    assert.deepEqual(snapshot(), initial)
  })

  await t.test('moving the correct answer to each of five positions refreshes booleans and preserves other quizzes and all unrelated data', () => {
    for (let correctIndex = 0; correctIndex < optionIds.length; correctIndex++) {
      // Clear the old answer before setting the new one to respect the single-answer index.
      withTransaction(writer, connection => {
        connection.prepare('UPDATE quiz_options SET is_correct = 0 WHERE quiz_id = ?').run(quizId)
        connection.prepare('UPDATE quiz_options SET is_correct = 1 WHERE id = ?').run(optionIds[correctIndex])
      })
      assertFlags(videoId, quizId, new Map(optionIds.map((id, index) => [id, index === correctIndex])))
      assertFlags(fixture.videoId, fixture.quizId, control)
    }
    const after = snapshot()
    for (const table of tables.filter(table => table !== 'quiz_options')) {
      assert.deepEqual(after.rows[table], initial.rows[table])
    }
    assert.deepEqual(after.rows.quiz_options, initial.rows.quiz_options.map(row => row.quiz_id === quizId
      ? { ...row, is_correct: row.id === optionIds[4] ? 1 : 0 } : row))
    assert.deepEqual(after.schema, initial.schema)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  })
})
