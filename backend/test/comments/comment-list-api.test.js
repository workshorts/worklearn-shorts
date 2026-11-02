import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const fields = ['id', 'videoId', 'nickname', 'content', 'createdAt']
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']
const internal = { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} }

test('the public comment GET returns committed five-field pages and recovers safely from database failures', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const fixture = insertMinimalFixture(database)
  database.prepare('UPDATE comments SET created_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', fixture.commentId)
  for (const id of [2, 3, Number.MAX_SAFE_INTEGER]) {
    database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(id, 'Comment parent ' + id, 'unused-media-path')
  }
  const target = [{ id: fixture.commentId, videoId: fixture.videoId, nickname: 'Fixture user', content: 'Fixture comment',
    createdAt: '2000-01-01T00:00:00.000Z' }]
  const insert = database.prepare('INSERT INTO comments (video_id, nickname, password_hash, content, created_at) VALUES (?, ?, ?, ?, ?)')
  for (let index = 1; index <= 22; index++) {
    const nickname = ' 작성자 ' + index
    const content = ' 댓글\n내용 ' + index
    const createdAt = `2001-01-${String(index % 3 + 1).padStart(2, '0')}T00:00:00.000Z`
    const id = insert.run(fixture.videoId, nickname, 'private-api-test-hash', content, createdAt).lastInsertRowid
    target.push({ id, videoId: fixture.videoId, nickname, content, createdAt })
  }
  target.sort((a, b) => a.createdAt === b.createdAt ? b.id - a.id : a.createdAt > b.createdAt ? -1 : 1)
  insert.run(2, 'Other author', 'private-other-hash', 'Other comment', '2100-01-01T00:00:00.000Z')
  const boundaryId = insert.run(Number.MAX_SAFE_INTEGER, 'Boundary author', 'private-boundary-hash', 'Boundary comment',
    '2002-01-01T00:00:00.000Z').lastInsertRowid

  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  const baseline = snapshot()
  const path = (id = fixture.videoId, query = '') => '/api/videos/' + id + '/comments' + query
  const expected = (page = 1, limit = 20) => ({ data: target.slice((page - 1) * limit, page * limit), page, limit, total: target.length })
  async function success(query = '', page = 1, limit = 20, options) {
    const response = await request(path(fixture.videoId, query), options)
    assert.equal(response.status, 200)
    assert.deepEqual(response.json, expected(page, limit))
    assert.deepEqual(Object.keys(response.json), ['data', 'page', 'limit', 'total'])
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    for (const row of response.json.data) assert.deepEqual(Object.keys(row), fields)
    assert.equal(response.text.includes('private-'), false)
    return response
  }

  await t.test('default public pages use the full filtered total, exact field names and deterministic latest order', async () => {
    await success()
    assert.deepEqual(snapshot(), baseline)
  })

  await t.test('normalized, minimum, maximum and empty end pages preserve the same total', async () => {
    for (const [query, page, limit] of [['?page=0002&limit=0002', 2, 2], ['?page=2', 2, 20],
      ['?limit=1', 1, 1], ['?limit=50', 1, 50], ['?page=3', 3, 20], ['?page=9007199254740991&limit=50', Number.MAX_SAFE_INTEGER, 50]]) {
      await success(query, page, limit)
    }
    const empty = await request(path(3))
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.json, { data: [], page: 1, limit: 20, total: 0 })
  })

  await t.test('public access needs neither admin authentication nor a visitor and maximum parent IDs stay exact', async () => {
    await success('?tagId=invalid&visitorId=invalid', 1, 20, { cookie: 'admin_session=invalid',
      headers: { 'X-Visitor-Id': ['invalid', 'also-invalid'], Origin: 'https://other.example.test' } })
    const boundary = await request(path('000' + Number.MAX_SAFE_INTEGER))
    assert.equal(boundary.status, 200)
    assert.deepEqual(boundary.json, { data: [{ id: boundaryId, videoId: Number.MAX_SAFE_INTEGER,
      nickname: 'Boundary author', content: 'Boundary comment', createdAt: '2002-01-01T00:00:00.000Z' }], page: 1, limit: 20, total: 1 })
  })

  await t.test('valid missing parents produce the video-specific 404 and invalid input still takes priority', async () => {
    for (const query of ['', '?page=9007199254740991&limit=50']) {
      const response = await request(path(4, query))
      assert.equal(response.status, 404)
      assert.deepEqual(response.json, { code: 'NOT_FOUND', message: '영상을 찾을 수 없습니다.', fields: {} })
    }
    for (const [url, field] of [[path(0), 'id'], [path(4, '?page=0'), 'page'], [path(4, '?limit=51'), 'limit']]) {
      const response = await request(url)
      assert.equal(response.status, 400)
      assert.equal(response.json.code, 'VALIDATION_ERROR')
      assert.deepEqual(Object.keys(response.json.fields), [field])
    }
  })

  await t.test('all reads remain bounded and read-only with one committed snapshot and no activity writes', async subtest => {
    database.exec('PRAGMA query_only = ON')
    const reads = []
    const commands = []
    const prepare = database.prepare.bind(database)
    const exec = database.exec.bind(database)
    const prepared = subtest.mock.method(database, 'prepare', sql => {
      const statement = prepare(sql)
      for (const method of ['get', 'all', 'run']) {
        const original = statement[method].bind(statement)
        subtest.mock.method(statement, method, (...params) => {
          reads.push({ method, active: database.isTransaction })
          return original(...params)
        })
      }
      return statement
    })
    const executed = subtest.mock.method(database, 'exec', sql => { commands.push(sql); return exec(sql) })
    try {
      await success('?limit=50', 1, 50)
      assert.ok(reads.length > 0 && reads.length <= 3)
      assert.ok(reads.every(read => read.active && read.method !== 'run'))
      assert.deepEqual(commands, ['BEGIN', 'COMMIT'])
    } finally {
      prepared.mock.restore()
      executed.mock.restore()
      database.exec('PRAGMA query_only = OFF')
    }
    assert.equal(database.isTransaction, false)
    assert.deepEqual(snapshot(), baseline)
  })

  await t.test('parent, count and page execution errors return a safe 500 then recover without leaking private values', async subtest => {
    const log = subtest.mock.method(console, 'error', () => {})
    const prepare = database.prepare.bind(database)
    for (const stage of ['parent', 'count', 'page']) {
      let reached = false
      const fault = subtest.mock.method(database, 'prepare', sql => {
        const statement = prepare(sql)
        const matches = stage === 'parent' ? sql.startsWith('SELECT id FROM videos') :
          stage === 'count' ? sql.startsWith('SELECT COUNT(*)') : sql.includes('FROM comments') && sql.includes('LIMIT')
        if (matches) subtest.mock.method(statement, stage === 'page' ? 'all' : 'get', () => {
          assert.equal(database.isTransaction, true)
          reached = true
          throw Object.assign(new Error('private-password/hash/SQL/path'), { status: 404, code: 'NOT_FOUND', fields: { private: 'value' } })
        })
        return statement
      })
      try {
        const response = await request(path())
        assert.equal(response.status, 500)
        assert.deepEqual(response.json, internal)
        assert.equal(response.headers['set-cookie'], undefined)
      } finally {
        fault.mock.restore()
      }
      assert.equal(reached, true)
      assert.equal(database.isTransaction, false)
      assert.deepEqual(snapshot(), baseline)
      await success()
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), Array.from({ length: 3 }, () => ['INTERNAL_ERROR']))
  })

  await t.test('commit failure cannot return success and the next complete request recovers', async subtest => {
    const log = subtest.mock.method(console, 'error', () => {})
    const exec = database.exec.bind(database)
    const commands = []
    const fault = subtest.mock.method(database, 'exec', sql => {
      commands.push(sql)
      if (sql === 'COMMIT') throw new Error('private-commit-failure')
      return exec(sql)
    })
    try {
      const response = await request(path())
      assert.equal(response.status, 500)
      assert.deepEqual(response.json, internal)
    } finally {
      fault.mock.restore()
    }
    assert.deepEqual(commands, ['BEGIN', 'COMMIT', 'ROLLBACK'])
    assert.equal(database.isTransaction, false)
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
    assert.deepEqual(snapshot(), baseline)
    await success()
  })
  assert.deepEqual(snapshot(), baseline)
})
