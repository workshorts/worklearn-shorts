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

test('the production like DELETE returns the committed public result and recovers without losing existing likes', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const fixture = insertMinimalFixture(database)
  database.prepare('UPDATE videos SET video_path = ? WHERE id = ?')
    .run('videos/10000000-0000-4000-8000-000000000001.mp4', fixture.videoId)
  const otherId = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Other cancel target', 'videos/10000000-0000-4000-8000-000000000002.webm').lastInsertRowid
  const maximumId = Number.MAX_SAFE_INTEGER
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
    .run(maximumId, 'Maximum cancel target', 'videos/10000000-0000-4000-8000-000000000003.mp4')
  const insert = database.prepare('INSERT INTO video_likes (video_id, visitor_id, created_at) VALUES (?, ?, ?)')
  for (const [id, visitor] of [[fixture.videoId, visitorA], [fixture.videoId, visitorB],
    [otherId, visitorA], [otherId, visitorB], [otherId, visitorC], [maximumId, visitorA]]) {
    insert.run(id, visitor, '2001-02-03T04:05:06.000Z')
  }
  for (const id of [fixture.videoId, otherId]) {
    database.prepare('INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)').run(id, visitorA)
  }

  function snapshot() {
    return {
      rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
      schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
      hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
    }
  }

  function cancel(id, visitor = visitorA, { query = '', ...options } = {}) {
    return request(`/api/videos/${id}/like` + query, { method: 'DELETE', ...options,
      headers: { 'X-Visitor-Id': visitor, ...options.headers },
    })
  }

  function assertReady() {
    assert.equal(database.isTransaction, false)
    assert.equal(database.isOpen, true)
  }

  function assertSuccess(response, videoId, likeCount, likedByMe = false) {
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.deepEqual(response.json, { videoId, likeCount, likedByMe })
    assertReady()
  }

  function assertInternal(response) {
    assert.equal(response.status, 500)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.deepEqual(response.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
    assertReady()
  }

  await t.test('a bodyless anonymous DELETE removes only the requested pair and returns exactly three public fields', async () => {
    const before = snapshot()
    assertSuccess(await cancel(fixture.videoId), fixture.videoId, 2)
    const after = snapshot()
    assert.deepEqual(after.rows.video_likes, before.rows.video_likes.filter(row =>
      !(row.video_id === fixture.videoId && row.visitor_id === visitorA)))
    for (const table of tables.filter(table => table !== 'video_likes')) {
      assert.deepEqual(after.rows[table], before.rows[table])
    }
    assert.deepEqual(after.schema, before.schema)
  })

  await t.test('normalized retries and never-liked pairs succeed without changing rows or using alternate identity values', async () => {
    const before = snapshot()
    assertSuccess(await cancel('000' + fixture.videoId, visitorA.toUpperCase(), {
      query: '?visitorId=' + visitorB, body: { visitorId: visitorB },
      cookie: 'visitorId=' + visitorB + '; admin_session=invalid',
      headers: { Origin: 'https://other.example.test' },
    }), fixture.videoId, 2)
    assert.deepEqual(snapshot(), before)
    assertSuccess(await cancel(fixture.videoId, visitorC), fixture.videoId, 2)
    assert.deepEqual(snapshot(), before)
  })

  await t.test('the maximum safe video ID returns zero after its last like is removed', async () => {
    assertSuccess(await cancel(maximumId), maximumId, 0)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_likes WHERE video_id = ?').get(maximumId).count, 0)
  })

  await t.test('valid missing videos return the shared 404 instead of successful cancellation', async () => {
    const before = snapshot()
    for (const id of [999999, maximumId - 1]) {
      const response = await cancel(id)
      assert.equal(response.status, 404)
      assert.deepEqual(response.json, { code: 'NOT_FOUND', message: '영상을 찾을 수 없습니다.', fields: {} })
      assert.equal(response.headers['set-cookie'], undefined)
      assertReady()
      assert.deepEqual(snapshot(), before)
    }
  })

  await t.test('a lookup failure returns one safe 500 and preserves the like until the next request succeeds', async subtest => {
    const before = snapshot()
    const log = subtest.mock.method(console, 'error', () => {})
    const fault = subtest.mock.method(database, 'prepare', () => {
      throw new Error('SELECT private_hash at C:/private/app.db with private-session')
    })
    try { assertInternal(await cancel(otherId)) }
    finally { fault.mock.restore() }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
    assert.deepEqual(snapshot(), before)
    assertSuccess(await cancel(otherId), otherId, 2)
  })

  await t.test('an aggregate failure restores the deleted pair and returns only a safe 500 before recovery', async subtest => {
    const before = snapshot()
    const log = subtest.mock.method(console, 'error', () => {})
    const prepare = database.prepare.bind(database)
    const fault = subtest.mock.method(database, 'prepare', sql => {
      if (sql.startsWith('SELECT COUNT(*)')) throw new Error('Injected cancel HTTP aggregate failure')
      return prepare(sql)
    })
    try { assertInternal(await cancel(otherId, visitorB)) }
    finally { fault.mock.restore() }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
    assert.deepEqual(snapshot(), before)
    assertSuccess(await cancel(otherId, visitorB), otherId, 1)
  })

  await t.test('a failed commit never sends success and restores the original row and timestamp before retry', async subtest => {
    const before = snapshot()
    const log = subtest.mock.method(console, 'error', () => {})
    const exec = database.exec.bind(database)
    const fault = subtest.mock.method(database, 'exec', sql => {
      if (sql === 'COMMIT') throw new Error('Injected cancel HTTP commit failure')
      return exec(sql)
    })
    try { assertInternal(await cancel(otherId, visitorC)) }
    finally { fault.mock.restore() }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
    assert.deepEqual(snapshot(), before)
    assertSuccess(await cancel(otherId, visitorC), otherId, 0)
  })

  await t.test('GETs observe cancellation and an existing PUT can register the same visitor again', async () => {
    const before = snapshot()
    const list = await request('/api/videos')
    assert.equal(list.status, 200)
    assert.deepEqual(list.json.data.map(video => [video.id, video.likeCount, video.likedByMe]),
      [[maximumId, 0, false], [otherId, 0, false], [fixture.videoId, 2, false]])
    for (const [id, expected] of [[maximumId, 0], [otherId, 0], [fixture.videoId, 2]]) {
      const detail = await request('/api/videos/' + id, { headers: { 'X-Visitor-Id': visitorA } })
      assert.equal(detail.status, 200)
      assert.equal(detail.json.likeCount, expected)
      assert.equal(detail.json.likedByMe, false)
    }
    const otherVisitor = await request('/api/videos/' + fixture.videoId, { headers: { 'X-Visitor-Id': visitorB } })
    assert.equal(otherVisitor.status, 200)
    assert.equal(otherVisitor.json.likeCount, 2)
    assert.equal(otherVisitor.json.likedByMe, true)
    assert.deepEqual(snapshot(), before)
    const added = await request(`/api/videos/${fixture.videoId}/like`, {
      method: 'PUT', headers: { 'X-Visitor-Id': visitorA },
    })
    assertSuccess(added, fixture.videoId, 3, true)
    assertSuccess(await cancel(fixture.videoId), fixture.videoId, 2)
    const after = snapshot()
    assert.deepEqual(after.rows, before.rows)
    assert.deepEqual(after.schema, before.schema)
  })
})
