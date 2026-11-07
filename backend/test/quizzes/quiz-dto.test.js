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

function assertDto(actual, expected) {
  assert.deepEqual(Object.keys(actual), ['id', 'videoId', 'question', 'options'])
  assert.equal(Object.getPrototypeOf(actual), Object.prototype)
  for (const id of [actual.id, actual.videoId]) assert.ok(Number.isSafeInteger(id) && id > 0)
  assert.equal(typeof actual.question, 'string')
  assert.ok(Array.isArray(actual.options))
  for (const option of actual.options) {
    assert.deepEqual(Object.keys(option), ['id', 'content', 'sortOrder', 'isCorrect'])
    assert.equal(Object.getPrototypeOf(option), Object.prototype)
    assert.ok(Number.isSafeInteger(option.id) && option.id > 0)
    assert.equal(typeof option.content, 'string')
    assert.ok(Number.isInteger(option.sortOrder) && option.sortOrder >= 1 && option.sortOrder <= 5)
    assert.equal(typeof option.isCorrect, 'boolean')
  }
  assert.deepEqual(actual, expected)
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected)
}

test('Quiz DTOs reuse the shared mapping with exact public fields and independent response objects', async t => {
  const context = createDatabaseContext(t)
  const path = context.path('quiz-dto.db')
  context.initialize(path)
  const db = context.open(path)
  const fixture = insertMinimalFixture(db)
  const question = '  첫 줄\n e\u0301 😀  '
  const content = ' 한글 e\u0301\n"<b>😀</b>" '
  db.prepare('UPDATE quizzes SET question = ? WHERE id = ?').run(question, fixture.quizId)
  db.prepare('UPDATE quiz_options SET content = ? WHERE id = ?').run(content, fixture.correctOptionId)
  const videoId = Number.MAX_SAFE_INTEGER - 1
  const quizId = Number.MAX_SAFE_INTEGER
  db.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(videoId, 'DTO boundary', 'unused-path')
  db.prepare('INSERT INTO quizzes (id, video_id, question) VALUES (?, ?, ?)').run(quizId, videoId, '😀'.repeat(200))
  const insert = db.prepare('INSERT INTO quiz_options (id, quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?, ?)')
  insert.run(Number.MAX_SAFE_INTEGER, quizId, '?', 2, 1)
  insert.run(9, quizId, '한😀'.repeat(50), 1, 0)
  const expected = new Map([
    [fixture.videoId, { id: fixture.quizId, videoId: fixture.videoId, question, options: [
      { id: fixture.correctOptionId, content, sortOrder: 1, isCorrect: true },
      { id: fixture.incorrectOptionId, content: 'Incorrect option', sortOrder: 2, isCorrect: false },
    ] }],
    [videoId, { id: quizId, videoId, question: '😀'.repeat(200), options: [
      { id: 9, content: '한😀'.repeat(50), sortOrder: 1, isCorrect: false },
      { id: Number.MAX_SAFE_INTEGER, content: '?', sortOrder: 2, isCorrect: true },
    ] }],
  ])
  db.exec('PRAGMA query_only = ON')
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  })
  const initial = snapshot()

  await t.test('real SQLite values retain exact field names, types, safe IDs and Unicode through both read paths and JSON', () => {
    for (const [id, dto] of expected) {
      assertDto(withTransaction(db, connection => loadQuiz(connection, id), { mode: 'DEFERRED' }), dto)
      assertDto(loadVideoQuiz(db, { id }), dto)
    }
    assert.equal(db.isTransaction, false)
    assert.deepEqual(snapshot(), initial)
  })

  await t.test('private row properties and serialization hooks stay internal and mutating one result cannot affect later reads', subtest => {
    function poison(row, fields) {
      for (const field of fields) {
        Object.defineProperty(row, field, { enumerable: true,
          get() { assert.fail(`Private row property must not be read: ${field}`) } })
      }
      return row
    }
    const prepare = db.prepare.bind(db)
    const prepared = subtest.mock.method(db, 'prepare', sql => {
      const statement = prepare(sql)
      if (sql.includes('FROM quizzes')) {
        const get = statement.get.bind(statement)
        subtest.mock.method(statement, 'get', (...args) => poison(get(...args),
          ['videoId', 'created_at', 'updated_at', 'password_hash', 'internal', 'toJSON']))
      }
      if (sql.includes('FROM quiz_options')) {
        const all = statement.all.bind(statement)
        subtest.mock.method(statement, 'all', (...args) => all(...args).map(row => poison(row,
          ['quiz_id', 'sortOrder', 'isCorrect', 'password_hash', 'internal', 'toJSON'])))
      }
      return statement
    })
    try {
      const first = withTransaction(db, connection => loadQuiz(connection, videoId), { mode: 'DEFERRED' })
      const second = loadVideoQuiz(db, { id: videoId })
      assertDto(first, expected.get(videoId))
      assertDto(second, expected.get(videoId))
      assert.notEqual(first, second)
      assert.notEqual(first.options, second.options)
      for (let index = 0; index < first.options.length; index++) assert.notEqual(first.options[index], second.options[index])
      first.question = 'Changed response only'
      first.internal = 'Changed response only'
      first.options[0].content = 'Changed response only'
      first.options.reverse()
      first.options.push({ id: -1 })
      assertDto(second, expected.get(videoId))
      assertDto(loadVideoQuiz(db, { id: videoId }), expected.get(videoId))
    } finally {
      prepared.mock.restore()
    }
    assert.equal(db.isTransaction, false)
    assert.deepEqual(snapshot(), initial)
  })
})
