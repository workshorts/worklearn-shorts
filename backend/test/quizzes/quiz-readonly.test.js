import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']
const otherVisitor = '00000000-0000-4000-8000-000000000002'

test('public quiz reads never persist client answers, scores, selections or other activity', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const db = getDb()
  const fixture = insertMinimalFixture(db)
  const noQuizVideo = db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('No quiz parent', 'unused-path').lastInsertRowid
  const expected = { id: fixture.quizId, videoId: fixture.videoId, question: 'Fixture question?', options: [
    { id: fixture.correctOptionId, content: 'Correct option', sortOrder: 1, isCorrect: true },
    { id: fixture.incorrectOptionId, content: 'Incorrect option', sortOrder: 2, isCorrect: false },
  ] }
  const selection = optionId => ({ quizId: fixture.quizId, answerId: optionId, selectedOptionId: optionId,
    score: 100, completed: true, isCorrect: optionId !== fixture.correctOptionId,
    question: 'Client override', options: [{ content: 'Client override', isCorrect: true }] })
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  const initial = snapshot()
  const path = `/api/videos/${fixture.videoId}/quiz`
  function responseState(response, status) {
    assert.equal(response.status, status)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.equal(response.headers['retry-after'], undefined)
    assert.equal(db.isTransaction, false)
  }
  function successful(response) {
    responseState(response, 200)
    assert.deepEqual(response.json, expected)
  }

  await t.test('repeated and concurrent reads ignore claimed selections in query, JSON body and cookies across visitors', async subtest => {
    assert.equal(db.prepare('PRAGMA query_only').get().query_only, 0)
    const prepare = db.prepare.bind(db)
    const exec = db.exec.bind(db)
    const prepared = subtest.mock.method(db, 'prepare', sql => {
      assert.match(sql, /^\s*SELECT\b/i, 'Quiz reads must not prepare mutation or schema statements')
      return prepare(sql)
    })
    const executed = subtest.mock.method(db, 'exec', sql => {
      assert.ok(['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql), 'Quiz reads must not issue write or schema commands')
      return exec(sql)
    })
    const log = subtest.mock.method(console, 'error', () => {})
    try {
      for (let repeat = 0; repeat < 2; repeat++) {
        for (const visitor of [null, fixture.visitorId, otherVisitor, 'invalid-unused-visitor']) {
          for (const optionId of [fixture.correctOptionId, fixture.incorrectOptionId]) {
            successful(await request(`${path}?selectedOptionId=${optionId}&answerId=${optionId}&score=100&completed=true`, {
              headers: { ...(visitor === null ? {} : { 'X-Visitor-Id': visitor }), Origin: 'https://other.example.test' },
              body: { ...selection(optionId), visitorId: visitor ?? 'client-anonymous' },
              cookie: `selectedOptionId=${optionId}; quizScore=100; admin_session=invalid-unused-session`,
            }))
          }
        }
      }
      const burst = await Promise.all(Array.from({ length: 8 }, (_, index) => request(path, {
        headers: { 'X-Visitor-Id': index % 2 === 0 ? fixture.visitorId : otherVisitor },
        body: selection(index % 2 === 0 ? fixture.correctOptionId : fixture.incorrectOptionId),
      })))
      burst.forEach(successful)
      successful(await request(path))
      assert.ok(prepared.mock.callCount() > 0)
      assert.ok(executed.mock.callCount() > 0)
      assert.equal(log.mock.callCount(), 0)
    } finally {
      prepared.mock.restore()
      executed.mock.restore()
      log.mock.restore()
    }
    assert.deepEqual(snapshot(), initial)
  })

  await t.test('unsupported mutation methods cannot submit answers and successful or rejected reads preserve state with writes disabled', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const id of [fixture.videoId, noQuizVideo]) {
        const response = await request(`/api/videos/${id}/quiz`, { method, body: selection(fixture.correctOptionId) })
        responseState(response, 404)
        assert.equal(response.json.code, 'NOT_FOUND')
        assert.deepEqual(response.json.fields, {})
      }
    }
    successful(await request(path))
    assert.deepEqual(snapshot(), initial)
    db.exec('PRAGMA query_only = ON')
    try {
      assert.equal(db.prepare('PRAGMA query_only').get().query_only, 1)
      successful(await request(path, { body: selection(fixture.incorrectOptionId) }))
      const absent = await request(`/api/videos/${noQuizVideo}/quiz`)
      responseState(absent, 404)
      assert.deepEqual(absent.json, { code: 'NOT_FOUND', message: '퀴즈를 찾을 수 없습니다.', fields: {} })
      const invalid = await request('/api/videos/0/quiz')
      responseState(invalid, 400)
      assert.equal(invalid.json.code, 'VALIDATION_ERROR')
      const malformed = await request(path, { body: '{"answerId":' })
      responseState(malformed, 400)
      assert.deepEqual(malformed.json, { code: 'INVALID_JSON', message: 'JSON 형식이 올바르지 않습니다.', fields: {} })
      assert.deepEqual(snapshot(), initial)
    } finally {
      db.exec('PRAGMA query_only = OFF')
    }
    assert.equal(db.prepare('PRAGMA query_only').get().query_only, 0)
    assert.deepEqual(snapshot(), initial)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  })
})
