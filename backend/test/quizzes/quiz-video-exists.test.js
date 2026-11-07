import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']
const missing = { code: 'NOT_FOUND', message: '영상을 찾을 수 없습니다.', fields: {} }

test('quiz requests check the validated parent without confusing absence with database failures', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const { requireQuizVideo } = await import('../../src/middleware/requireQuizVideo.js')
  const db = getDb()
  const fixture = insertMinimalFixture(db)
  for (const id of [2, Number.MAX_SAFE_INTEGER]) {
    db.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(id, 'Quiz parent', 'unused-path')
  }
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  const initial = snapshot()
  const get = id => request(`/api/videos/${id}/quiz`, {
    headers: { 'X-Visitor-Id': 'invalid-unused-visitor', Origin: 'https://other.example.test' },
    cookie: 'admin_session=invalid-unused-session',
  })
  function responseError(response, status, expected) {
    assert.equal(response.status, status)
    assert.deepEqual(response.json, expected)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.equal(response.headers['retry-after'], undefined)
    assert.equal(db.isTransaction, false)
  }

  await t.test('existing parents with or without a quiz continue after one bound ID-only read without requiring media or credentials', subtest => {
    const reads = []
    const prepare = db.prepare.bind(db)
    const prepared = subtest.mock.method(db, 'prepare', sql => {
      const statement = prepare(sql)
      const get = statement.get.bind(statement)
      subtest.mock.method(statement, 'get', (...args) => { reads.push({ sql, args }); return get(...args) })
      return statement
    })
    const executed = subtest.mock.method(db, 'exec', () => assert.fail('Parent lookup must not control a transaction'))
    try {
      for (const id of [fixture.videoId, 2, Number.MAX_SAFE_INTEGER]) {
        const input = Object.freeze({ id })
        const res = { locals: { videoQuizRequest: input, existing: 'preserved' } }
        let calls = 0
        requireQuizVideo({ get headers() { assert.fail('Parent lookup must not read credentials') } }, res, () => { calls += 1 })
        assert.equal(calls, 1)
        assert.deepEqual(res.locals, { videoQuizRequest: input, existing: 'preserved' })
        assert.equal(res.locals.videoQuizRequest, input)
      }
      assert.deepEqual(reads, [fixture.videoId, 2, Number.MAX_SAFE_INTEGER]
        .map(id => ({ sql: 'SELECT id FROM videos WHERE id = ?', args: [id] })))
      assert.equal(executed.mock.callCount(), 0)
    } finally {
      prepared.mock.restore()
      executed.mock.restore()
    }
    assert.deepEqual(snapshot(), initial)
  })

  await t.test('invalid IDs stop before SQL and absent parents receive the video-specific 404 without quiz queries', async subtest => {
    const queries = []
    const prepare = db.prepare.bind(db)
    const prepared = subtest.mock.method(db, 'prepare', sql => {
      queries.push(sql)
      return prepare(sql)
    })
    const executed = subtest.mock.method(db, 'exec', () => assert.fail('Parent preflight must remain read-only'))
    const log = subtest.mock.method(console, 'error', () => {})
    try {
      responseError(await get('0'), 400, { code: 'VALIDATION_ERROR', message: '입력값을 확인하세요.',
        fields: { id: 'ID는 1 이상 9007199254740991 이하의 정수로 입력하세요.' } })
      assert.equal(prepared.mock.callCount(), 0)
      for (const id of ['3', '0003', String(Number.MAX_SAFE_INTEGER - 1)]) responseError(await get(id), 404, missing)
      assert.deepEqual(queries, Array(3).fill('SELECT id FROM videos WHERE id = ?'))
      assert.equal(executed.mock.callCount(), 0)
      assert.equal(log.mock.callCount(), 0)
    } finally {
      prepared.mock.restore()
      executed.mock.restore()
      log.mock.restore()
    }
    assert.deepEqual(snapshot(), initial)
  })

  await t.test('native prepare and execution failures remain safe 500s and the same connection recovers', async subtest => {
    const log = subtest.mock.method(console, 'error', () => {})
    for (const stage of ['prepare', 'get']) {
      const prepare = db.prepare.bind(db)
      const fault = Object.assign(new Error('private-quiz-parent-SQL-path'), { status: 404, code: 'NOT_FOUND' })
      const prepared = subtest.mock.method(db, 'prepare', sql => {
        assert.equal(sql, 'SELECT id FROM videos WHERE id = ?')
        if (stage === 'prepare') throw fault
        const statement = prepare(sql)
        subtest.mock.method(statement, 'get', () => { throw fault })
        return statement
      })
      try {
        responseError(await get(fixture.videoId), 500, {
          code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {},
        })
        assert.equal(prepared.mock.callCount(), 1)
      } finally {
        prepared.mock.restore()
      }
      assert.equal(db.isOpen, true)
      assert.deepEqual(snapshot(), initial)
      responseError(await get(3), 404, missing)
      let calls = 0
      requireQuizVideo({}, { locals: { videoQuizRequest: { id: fixture.videoId } } }, () => { calls += 1 })
      assert.equal(calls, 1)
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR'], ['INTERNAL_ERROR']])
    assert.deepEqual(snapshot(), initial)
  })
})
