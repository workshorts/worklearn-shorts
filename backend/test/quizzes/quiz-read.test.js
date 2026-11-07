import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { openExistingDatabase } from '../../src/db/connection.js'
import { withTransaction } from '../../src/db/transaction.js'
import { ApiError } from '../../src/errors.js'
import { loadVideoQuiz } from '../../src/services/quiz-read.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']
const quizMissing = { code: 'NOT_FOUND', message: '퀴즈를 찾을 수 없습니다.', fields: {} }
const videoMissing = { code: 'NOT_FOUND', message: '영상을 찾을 수 없습니다.', fields: {} }

test('quiz reads reuse the shared loader inside a committed parent and option snapshot', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const { loadQuizForVideo } = await import('../../src/middleware/loadQuizForVideo.js')
  const db = getDb()
  assert.equal(db.prepare('PRAGMA journal_mode = WAL').get().journal_mode, 'wal')
  const fixture = insertMinimalFixture(db)
  for (const id of [2, Number.MAX_SAFE_INTEGER]) {
    db.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(id, 'Quiz read parent', 'unused-path')
  }
  db.prepare('INSERT INTO quizzes (id, video_id, question) VALUES (?, ?, ?)')
    .run(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'Boundary question?')
  const option = db.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
  option.run(Number.MAX_SAFE_INTEGER, 'Boundary correct', 1, 1)
  option.run(Number.MAX_SAFE_INTEGER, 'Boundary other', 2, 0)
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  const get = id => request(`/api/videos/${id}/quiz`, {
    headers: { 'X-Visitor-Id': 'invalid-unused-visitor', Origin: 'https://other.example.test' },
  })
  function responseError(response, status, expected) {
    assert.equal(response.status, status)
    assert.deepEqual(response.json, expected)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.equal(response.headers['retry-after'], undefined)
    assert.equal(db.isTransaction, false)
  }

  await t.test('parent, quiz and options share one deferred transaction and middleware publishes data only after commit', subtest => {
    const before = snapshot()
    const commands = []
    const reads = []
    const exec = db.exec.bind(db)
    const prepare = db.prepare.bind(db)
    const executed = subtest.mock.method(db, 'exec', sql => { commands.push(sql); return exec(sql) })
    const prepared = subtest.mock.method(db, 'prepare', sql => {
      const statement = prepare(sql)
      for (const method of ['get', 'all']) {
        const original = statement[method].bind(statement)
        subtest.mock.method(statement, method, (...args) => {
          reads.push({ sql, args, active: db.isTransaction })
          return original(...args)
        })
      }
      return statement
    })
    try {
      const quiz = loadVideoQuiz(db, { id: fixture.videoId })
      assert.equal(quiz.id, fixture.quizId)
      assert.equal(quiz.videoId, fixture.videoId)
      assert.equal(quiz.question, 'Fixture question?')
      assert.deepEqual(commands, ['BEGIN', 'COMMIT'])
      assert.equal(reads.length, 3)
      assert.ok(reads.every(read => read.active))
      assert.deepEqual(reads.map(read => read.args), [[fixture.videoId], [fixture.videoId], [fixture.quizId]])
      assert.match(reads[0].sql, /^SELECT id FROM videos/)
      assert.match(reads[1].sql, /^SELECT id, video_id, question FROM quizzes/)
      assert.match(reads[2].sql, /FROM quiz_options/)
    } finally {
      prepared.mock.restore()
      executed.mock.restore()
    }
    const boundary = loadVideoQuiz(db, { id: Number.MAX_SAFE_INTEGER })
    assert.equal(boundary.id, Number.MAX_SAFE_INTEGER)
    assert.equal(boundary.videoId, Number.MAX_SAFE_INTEGER)
    const input = Object.freeze({ id: fixture.videoId })
    const res = { locals: { videoQuizRequest: input, existing: 'preserved' } }
    let calls = 0
    loadQuizForVideo({}, res, () => { assert.equal(db.isTransaction, false); calls += 1 })
    assert.equal(calls, 1)
    assert.equal(res.locals.videoQuizRequest, input)
    assert.equal(res.locals.existing, 'preserved')
    assert.equal(res.locals.videoQuiz.id, fixture.quizId)
    assert.deepEqual(snapshot(), before)
  })

  await t.test('missing parents and absent quizzes have distinct 404s and failures publish no quiz context', async () => {
    const before = snapshot()
    for (const [id, expected] of [[3, videoMissing], [2, quizMissing]]) {
      const res = { locals: { videoQuizRequest: { id }, existing: 'preserved' } }
      const previous = { ...res.locals }
      assert.throws(() => loadQuizForVideo({}, res, () => assert.fail('Missing targets must not continue')), error => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.status, 404)
        assert.deepEqual({ code: error.code, message: error.message, fields: error.fields }, expected)
        return true
      })
      assert.equal(db.isTransaction, false)
      assert.deepEqual(res.locals, previous)
      responseError(await get(id), 404, expected)
    }
    assert.deepEqual(snapshot(), before)
  })

  await t.test('quiz preparation, option execution and commit failures return safe 500s, roll back and recover', async subtest => {
    const before = snapshot()
    const log = subtest.mock.method(console, 'error', () => {})
    for (const stage of ['quiz', 'options', 'commit']) {
      const failure = Object.assign(new Error('private-quiz-read-SQL-path'), { status: 404, code: 'NOT_FOUND' })
      const prepare = db.prepare.bind(db)
      const exec = db.exec.bind(db)
      let reached = false
      const prepared = subtest.mock.method(db, 'prepare', sql => {
        if (stage === 'quiz' && sql.startsWith('SELECT id, video_id, question FROM quizzes')) {
          reached = true
          throw failure
        }
        const statement = prepare(sql)
        if (stage === 'options' && sql.includes('FROM quiz_options')) {
          subtest.mock.method(statement, 'all', () => { reached = true; throw failure })
        }
        return statement
      })
      const executed = subtest.mock.method(db, 'exec', sql => {
        if (stage === 'commit' && sql === 'COMMIT') { reached = true; throw failure }
        return exec(sql)
      })
      try {
        responseError(await get(fixture.videoId), 500, {
          code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {},
        })
        assert.equal(reached, true)
      } finally {
        prepared.mock.restore()
        executed.mock.restore()
      }
      assert.equal(db.isOpen, true)
      assert.deepEqual(snapshot(), before)
      assert.equal(loadVideoQuiz(db, { id: fixture.videoId }).id, fixture.quizId)
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR'], ['INTERNAL_ERROR'], ['INTERNAL_ERROR']])
  })

  await t.test('WAL readers retain matching questions and options and recheck parents deleted after preflight', async subtest => {
    const writer = openExistingDatabase(databasePath)
    try {
      const original = loadVideoQuiz(db, { id: fixture.videoId })
      const prepare = db.prepare.bind(db)
      let changed = false
      const prepared = subtest.mock.method(db, 'prepare', sql => {
        const statement = prepare(sql)
        if (sql === 'SELECT id FROM videos WHERE id = ?') {
          const get = statement.get.bind(statement)
          subtest.mock.method(statement, 'get', (...args) => {
            const parent = get(...args)
            if (!changed) {
              withTransaction(writer, connection => {
                connection.prepare('UPDATE quizzes SET question = ? WHERE id = ?').run('Changed question?', fixture.quizId)
                connection.prepare('UPDATE quiz_options SET content = ? WHERE id = ?').run('Changed option', fixture.correctOptionId)
              })
              changed = true
            }
            return parent
          })
        }
        return statement
      })
      try { assert.deepEqual(loadVideoQuiz(db, { id: fixture.videoId }), original) }
      finally { prepared.mock.restore() }
      assert.equal(changed, true)
      const changedState = snapshot()
      assert.deepEqual(loadVideoQuiz(db, { id: fixture.videoId }), { ...original, question: 'Changed question?',
        options: original.options.map(option => option.id === fixture.correctOptionId ? { ...option, content: 'Changed option' } : option) })
      assert.deepEqual(snapshot(), changedState)

      const exec = db.exec.bind(db)
      let deletedState
      const executed = subtest.mock.method(db, 'exec', sql => {
        if (sql === 'BEGIN' && !deletedState) {
          writer.prepare('DELETE FROM videos WHERE id = ?').run(Number.MAX_SAFE_INTEGER)
          deletedState = snapshot()
        }
        return exec(sql)
      })
      try { responseError(await get(Number.MAX_SAFE_INTEGER), 404, videoMissing) }
      finally { executed.mock.restore() }
      assert.ok(deletedState)
      assert.deepEqual(snapshot(), deletedState)
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    } finally {
      writer.close()
    }
  })
})
