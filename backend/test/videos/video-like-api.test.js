import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const visitorA = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const visitorB = '12345678-abcd-4abc-9def-012345abcdef'
const visitorC = 'fedcba98-7654-4abc-bdef-012345abcdef'
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('the production like PUT returns the committed public result and safely recovers from write failures', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const fixture = insertMinimalFixture(database)
  database.prepare('UPDATE videos SET video_path = ? WHERE id = ?')
    .run('videos/10000000-0000-4000-8000-000000000001.mp4', fixture.videoId)
  const insert = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
  const firstId = insert.run('First public like target', 'videos/10000000-0000-4000-8000-000000000002.mp4').lastInsertRowid
  const secondId = insert.run('Second public like target', 'videos/10000000-0000-4000-8000-000000000003.webm').lastInsertRowid
  const maximumId = Number.MAX_SAFE_INTEGER
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
    .run(maximumId, 'Maximum like target', 'videos/10000000-0000-4000-8000-000000000004.mp4')

  function snapshot() {
    return {
      rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
      schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
      hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
    }
  }

  function put(id, visitor = visitorA, { query = '', ...options } = {}) {
    return request(`/api/videos/${id}/like` + query, { method: 'PUT', ...options,
      headers: { 'X-Visitor-Id': visitor, ...options.headers },
    })
  }

  function assertReady() {
    assert.equal(database.isTransaction, false)
    assert.equal(database.isOpen, true)
  }

  function assertSuccess(response, videoId, likeCount) {
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.deepEqual(response.json, { videoId, likeCount, likedByMe: true })
    assertReady()
  }

  function assertInternal(response) {
    assert.equal(response.status, 500)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.deepEqual(response.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
    assertReady()
  }

  await t.test('a bodyless anonymous PUT adds only the requested like and returns exactly three public fields', async () => {
    const before = snapshot()
    assertSuccess(await put(firstId), firstId, 1)
    const after = snapshot()
    const pair = row => row.video_id === firstId && row.visitor_id === visitorA
    assert.equal(after.rows.video_likes.filter(pair).length, 1)
    assert.deepEqual(after.rows.video_likes.filter(row => !pair(row)), before.rows.video_likes)
    for (const table of tables.filter(table => table !== 'video_likes')) {
      assert.deepEqual(after.rows[table], before.rows[table])
    }
    assert.deepEqual(after.schema, before.schema)
  })

  await t.test('normalized duplicates keep the same result and ignore alternate identity values or administrator cookies', async () => {
    const before = snapshot()
    assertSuccess(await put('000' + firstId, visitorA.toUpperCase(), {
      query: '?visitorId=' + visitorB, body: { visitorId: visitorB },
      cookie: 'visitorId=' + visitorB + '; admin_session=invalid',
      headers: { Origin: 'https://other.example.test' },
    }), firstId, 1)
    assert.deepEqual(snapshot(), before)
  })

  await t.test('the maximum safe video ID is returned as the requested ID instead of the inserted row ID', async () => {
    assertSuccess(await put(maximumId), maximumId, 1)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_likes WHERE video_id = ?').get(maximumId).count, 1)
  })

  await t.test('valid missing videos return the common 404 without changing any database state', async () => {
    const before = snapshot()
    for (const id of [999999, maximumId - 1]) {
      const response = await put(id)
      assert.equal(response.status, 404)
      assert.deepEqual(response.json, { code: 'NOT_FOUND', message: '영상을 찾을 수 없습니다.', fields: {} })
      assert.equal(response.headers['set-cookie'], undefined)
      assertReady()
      assert.deepEqual(snapshot(), before)
    }
  })

  await t.test('a lookup failure returns one safe 500 and the next request can add a new like', async subtest => {
    const before = snapshot()
    const log = subtest.mock.method(console, 'error', () => {})
    const fault = subtest.mock.method(database, 'prepare', () => {
      throw new Error('SELECT private_hash at C:/private/app.db with private-session')
    })
    try { assertInternal(await put(secondId)) }
    finally { fault.mock.restore() }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
    assert.deepEqual(snapshot(), before)
    assertSuccess(await put(secondId), secondId, 1)
  })

  await t.test('an aggregate failure returns no success and rolls back the inserted like before retry', async subtest => {
    const before = snapshot()
    const log = subtest.mock.method(console, 'error', () => {})
    const prepare = database.prepare.bind(database)
    const fault = subtest.mock.method(database, 'prepare', sql => {
      if (sql.startsWith('SELECT COUNT(*)')) throw new Error('Injected like HTTP aggregate failure')
      return prepare(sql)
    })
    try { assertInternal(await put(secondId, visitorB)) }
    finally { fault.mock.restore() }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
    assert.deepEqual(snapshot(), before)
    assertSuccess(await put(secondId, visitorB), secondId, 2)
  })

  await t.test('a commit failure rolls back and produces only the safe 500 before a new retry succeeds', async subtest => {
    const before = snapshot()
    const log = subtest.mock.method(console, 'error', () => {})
    const exec = database.exec.bind(database)
    const fault = subtest.mock.method(database, 'exec', sql => {
      if (sql === 'COMMIT') throw new Error('Injected like HTTP commit failure')
      return exec(sql)
    })
    try { assertInternal(await put(secondId, visitorC)) }
    finally { fault.mock.restore() }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
    assert.deepEqual(snapshot(), before)
    assertSuccess(await put(secondId, visitorC), secondId, 3)
  })

  await t.test('existing list and detail GETs observe committed likes for each header without changing likes or views', async () => {
    const before = snapshot()
    const list = await request('/api/videos')
    assert.equal(list.status, 200)
    assert.deepEqual(list.json.data.map(video => [video.id, video.likeCount, video.likedByMe]),
      [[maximumId, 1, false], [secondId, 3, false], [firstId, 1, false], [fixture.videoId, 1, false]])
    for (const [id, count, liked] of [[maximumId, 1, true], [secondId, 3, true], [firstId, 1, true], [fixture.videoId, 1, false]]) {
      const detail = await request('/api/videos/' + id, { headers: { 'X-Visitor-Id': visitorA } })
      assert.equal(detail.status, 200)
      assert.equal(detail.json.likeCount, count)
      assert.equal(detail.json.likedByMe, liked)
    }
    assert.deepEqual(snapshot(), before)
  })
})
