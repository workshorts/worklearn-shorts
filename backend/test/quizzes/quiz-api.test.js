import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('public quiz GET returns its committed Quiz DTO and preserves error and recovery contracts', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const db = getDb()
  const fixture = insertMinimalFixture(db)
  for (const id of [2, Number.MAX_SAFE_INTEGER]) {
    db.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(id, 'Quiz API parent', 'unused-path')
  }
  db.prepare('INSERT INTO quizzes (id, video_id, question) VALUES (?, ?, ?)')
    .run(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, ' 경계 문제 😀 ')
  const insert = db.prepare('INSERT INTO quiz_options (id, quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?, ?)')
  insert.run(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, '정답', 2, 1)
  insert.run(90, Number.MAX_SAFE_INTEGER, ' 오답\n ', 1, 0)
  const expected = new Map([
    [fixture.videoId, { id: fixture.quizId, videoId: fixture.videoId, question: 'Fixture question?', options: [
      { id: fixture.correctOptionId, content: 'Correct option', sortOrder: 1, isCorrect: true },
      { id: fixture.incorrectOptionId, content: 'Incorrect option', sortOrder: 2, isCorrect: false },
    ] }],
    [Number.MAX_SAFE_INTEGER, { id: Number.MAX_SAFE_INTEGER, videoId: Number.MAX_SAFE_INTEGER,
      question: ' 경계 문제 😀 ', options: [
        { id: 90, content: ' 오답\n ', sortOrder: 1, isCorrect: false },
        { id: Number.MAX_SAFE_INTEGER, content: '정답', sortOrder: 2, isCorrect: true },
      ] }],
  ])
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  const initial = snapshot()
  const get = (id = fixture.videoId, options) => request(`/api/videos/${id}/quiz`, options)
  function jsonResponse(response, status) {
    assert.equal(response.status, status)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.equal(response.headers['retry-after'], undefined)
    assert.equal(db.isTransaction, false)
  }
  function publicQuiz(response, id = fixture.videoId) {
    jsonResponse(response, 200)
    assert.deepEqual(Object.keys(response.json), ['id', 'videoId', 'question', 'options'])
    for (const option of response.json.options) {
      assert.deepEqual(Object.keys(option), ['id', 'content', 'sortOrder', 'isCorrect'])
      assert.equal(typeof option.isCorrect, 'boolean')
    }
    assert.deepEqual(response.json, expected.get(id))
  }

  await t.test('anonymous and ignored-credential requests return exact Quiz JSON for normalized and maximum IDs', async () => {
    publicQuiz(await get())
    publicQuiz(await get('000' + fixture.videoId, {
      headers: { 'X-Visitor-Id': 'invalid-unused-visitor', Origin: 'https://other.example.test' },
      cookie: 'admin_session=invalid-unused-session',
    }))
    publicQuiz(await get(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)
    publicQuiz(await get('000' + Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)
    publicQuiz(await request(`/api/videos/${fixture.videoId}/quiz?page=0&limit=0&tagId=invalid&visitorId=invalid`))
    assert.deepEqual(snapshot(), initial)
  })

  await t.test('success follows one parent preflight and one committed deferred snapshot without other queries or writes', async subtest => {
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
      publicQuiz(await get())
      assert.deepEqual(commands, ['BEGIN', 'COMMIT'])
      assert.equal(reads.length, 4)
      assert.deepEqual(reads.map(read => read.active), [false, true, true, true])
      assert.deepEqual(reads.map(read => read.args), [[fixture.videoId], [fixture.videoId], [fixture.videoId], [fixture.quizId]])
      assert.ok(reads[0].sql.startsWith('SELECT id FROM videos'))
      assert.ok(reads[1].sql.startsWith('SELECT id FROM videos'))
      assert.ok(reads[2].sql.startsWith('SELECT id, video_id, question FROM quizzes'))
      assert.ok(reads[3].sql.includes('FROM quiz_options'))
    } finally {
      prepared.mock.restore()
      executed.mock.restore()
    }
    assert.deepEqual(snapshot(), initial)
  })

  await t.test('invalid IDs retain 400 and missing videos and quizzes retain their distinct 404 responses', async subtest => {
    const log = subtest.mock.method(console, 'error', () => {})
    for (const id of ['0', '9007199254740992']) {
      const response = await get(id)
      jsonResponse(response, 400)
      assert.deepEqual(response.json, { code: 'VALIDATION_ERROR', message: '입력값을 확인하세요.',
        fields: { id: 'ID는 1 이상 9007199254740991 이하의 정수로 입력하세요.' } })
    }
    for (const [id, message] of [[3, '영상을 찾을 수 없습니다.'], [2, '퀴즈를 찾을 수 없습니다.']]) {
      const response = await get(id)
      jsonResponse(response, 404)
      assert.deepEqual(response.json, { code: 'NOT_FOUND', message, fields: {} })
    }
    assert.equal(log.mock.callCount(), 0)
    assert.deepEqual(snapshot(), initial)
  })

  await t.test('commit failures cannot send a successful quiz and recovery returns a fresh 200 on the same connection', async subtest => {
    const log = subtest.mock.method(console, 'error', () => {})
    const exec = db.exec.bind(db)
    let reached = false
    const fault = subtest.mock.method(db, 'exec', sql => {
      if (sql === 'COMMIT') {
        reached = true
        throw Object.assign(new Error('private-quiz-commit-details'), { status: 200, code: 'NOT_FOUND' })
      }
      return exec(sql)
    })
    try {
      const response = await get()
      jsonResponse(response, 500)
      assert.deepEqual(response.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
      assert.equal(reached, true)
    } finally {
      fault.mock.restore()
    }
    assert.equal(db.isOpen, true)
    assert.deepEqual(snapshot(), initial)
    publicQuiz(await get())
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
    assert.deepEqual(snapshot(), initial)
  })
})
