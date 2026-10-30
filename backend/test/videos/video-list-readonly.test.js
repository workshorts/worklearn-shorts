import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { withTransaction } from '../../src/db/transaction.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']
const visitorId = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const newVisitor = '12345678-abcd-4abc-9def-012345abcdef'
const createdAt = '2001-02-03T04:05:06.000Z'
const updatedAt = '2002-03-04T05:06:07.000Z'

test('video list GET preserves persistent state for successful, empty, rejected and failed reads', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const database = getDb()

  function snapshot() {
    return {
      tables: Object.fromEntries(tables.map(table =>
        [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
      schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
      hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
    }
  }

  function assertPreserved(before) {
    assert.deepEqual(snapshot(), before)
    assert.equal(database.isOpen, true)
    assert.equal(database.isTransaction, false)
  }

  async function readPage(query, visitor = null) {
    const response = await request('/api/videos' + query, {
      headers: visitor === null ? {} : { 'X-Visitor-Id': visitor },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers['set-cookie'], undefined)
    return response.json
  }

  await t.test('repeated empty-database requests do not register a visitor or create activity', async () => {
    const before = snapshot()
    for (let iteration = 0; iteration < 2; iteration += 1) {
      for (const visitor of [null, newVisitor]) {
        const response = await readPage('', visitor)
        assert.deepEqual(response, { data: [], page: 1, limit: 20, total: 0 })
        assertPreserved(before)
      }
    }
  })

  const fixture = insertMinimalFixture(database)
  withTransaction(database, connection => {
    connection.prepare('UPDATE videos SET video_path = ?, created_at = ?, updated_at = ? WHERE id = ?')
      .run('videos/10000000-0000-4000-8000-000000000001.mp4', createdAt, updatedAt, fixture.videoId)
    connection.prepare('UPDATE video_views SET visitor_id = ? WHERE video_id = ?').run(visitorId, fixture.videoId)
    connection.prepare('UPDATE video_likes SET visitor_id = ? WHERE video_id = ?').run(visitorId, fixture.videoId)
    connection.prepare('INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)')
      .run(fixture.videoId, fixture.visitorId)
    const insert = connection.prepare('INSERT INTO videos (title, video_path, created_at, updated_at) VALUES (?, ?, ?, ?)')
    for (const title of ['Inactive second video', 'Inactive third video']) {
      insert.run(title, 'videos/10000000-0000-4000-8000-000000000002.webm', createdAt, updatedAt)
    }
  })

  await t.test('repeated pages preserve all rows and timestamps without recording first or duplicate views and likes', async () => {
    const before = snapshot()
    const baselines = new Map()
    for (let iteration = 0; iteration < 3; iteration += 1) {
      for (const visitor of [null, visitorId.toUpperCase(), newVisitor]) {
        for (const query of ['', '?page=1&limit=1', '?page=2&limit=1', '?page=3&limit=1']) {
          const response = await readPage(query, visitor)
          assert.equal(response.total, 3)
          assert.equal(response.data.length, query === '' ? 3 : 1)
          for (const video of response.data) {
            const active = video.id === fixture.videoId
            assert.equal(video.viewCount, active ? 2 : 0)
            assert.equal(video.likeCount, active ? 1 : 0)
            assert.equal(video.likedByMe, active && visitor === visitorId.toUpperCase())
            assert.equal(video.createdAt, createdAt)
            assert.equal(video.updatedAt, updatedAt)
          }
          const key = JSON.stringify([query, visitor])
          if (baselines.has(key)) assert.deepEqual(response, baselines.get(key))
          else baselines.set(key, response)
          assertPreserved(before)
        }
      }
    }
  })

  await t.test('out-of-range and maximum pages preserve the populated database for new visitors', async () => {
    const before = snapshot()
    for (let iteration = 0; iteration < 2; iteration += 1) {
      for (const query of ['?page=99&limit=1', `?page=${Number.MAX_SAFE_INTEGER}&limit=50`]) {
        const response = await readPage(query, newVisitor)
        assert.deepEqual(response.data, [])
        assert.equal(response.total, 3)
        assertPreserved(before)
      }
    }
  })

  await t.test('normal, paginated and empty list reads succeed with SQLite writes disabled and leave the flag enabled', async () => {
    const before = snapshot()
    database.exec('PRAGMA query_only = ON')
    try {
      for (const visitor of [null, visitorId]) {
        for (const query of ['', '?page=1&limit=1', '?page=3&limit=1', '?page=99&limit=50']) {
          assert.equal((await readPage(query, visitor)).total, 3)
          assert.equal(database.prepare('PRAGMA query_only').get().query_only, 1)
          assertPreserved(before)
        }
      }
    } finally {
      database.exec('PRAGMA query_only = OFF')
    }
    assert.equal(database.prepare('PRAGMA query_only').get().query_only, 0)
  })

  await t.test('invalid pagination and visitor headers return 400 without changing persistent state', async () => {
    const before = snapshot()
    for (const [query, headers] of [
      ['?page=0', {}], ['?limit=51', {}],
      ['', { 'X-Visitor-Id': 'invalid-visitor' }],
      ['', { 'X-Visitor-Id': [visitorId, visitorId] }],
    ]) {
      const response = await request('/api/videos' + query, { headers })
      assert.equal(response.status, 400)
      assert.equal(response.json.code, 'VALIDATION_ERROR')
      assertPreserved(before)
    }
  })

  await t.test('query and commit failures preserve all state and allow subsequent successful list reads', async subtest => {
    const before = snapshot()
    const log = subtest.mock.method(console, 'error', () => {})
    for (const method of ['prepare', 'exec']) {
      const original = database[method].bind(database)
      const fault = subtest.mock.method(database, method, (...args) => {
        if (method === 'prepare' || args[0] === 'COMMIT') throw new Error('Injected list read failure')
        return original(...args)
      })
      try {
        const response = await request('/api/videos')
        assert.equal(response.status, 500)
        assert.deepEqual(response.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
      } finally {
        fault.mock.restore()
      }
      assertPreserved(before)
      assert.equal((await readPage('')).total, 3)
      assertPreserved(before)
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR'], ['INTERNAL_ERROR']])
  })
})
