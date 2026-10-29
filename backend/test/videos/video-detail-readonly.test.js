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
const otherVisitor = '12345678-abcd-4abc-9def-012345abcdef'
const createdAt = '2001-02-03T04:05:06.000Z'
const updatedAt = '2002-03-04T05:06:07.000Z'

test('public video detail GET preserves persistent state after the latest administrator read merge', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const fixture = insertMinimalFixture(database)
  let pristineId
  withTransaction(database, () => {
    database.prepare('UPDATE videos SET video_path = ?, thumbnail_path = ?, created_at = ?, updated_at = ? WHERE id = ?')
      .run('videos/10000000-0000-4000-8000-000000000001.mp4',
        'thumbnails/20000000-0000-4000-8000-000000000001.png', createdAt, updatedAt, fixture.videoId)
    database.prepare('UPDATE video_views SET visitor_id = ? WHERE video_id = ?').run(visitorId, fixture.videoId)
    database.prepare('UPDATE video_likes SET visitor_id = ? WHERE video_id = ?').run(visitorId, fixture.videoId)
    database.prepare('INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)').run(fixture.videoId, otherVisitor)
    pristineId = database.prepare(
      'INSERT INTO videos (title, video_path, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('Pristine video', 'videos/10000000-0000-4000-8000-000000000002.webm', createdAt, updatedAt).lastInsertRowid
  })

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

  await t.test('repeated anonymous and visitor-specific reads preserve all rows, timestamps, sequences and file bytes', async () => {
    const before = snapshot()
    const baselines = new Map()
    for (let iteration = 0; iteration < 3; iteration += 1) {
      for (const visitor of [null, visitorId.toUpperCase(), otherVisitor]) {
        const headers = visitor === null ? {} : { 'X-Visitor-Id': visitor }
        const response = await request(`/api/videos/${fixture.videoId}`, { headers })
        assert.equal(response.status, 200)
        assert.equal(response.json.id, fixture.videoId)
        assert.equal(response.json.createdAt, createdAt)
        assert.equal(response.json.updatedAt, updatedAt)
        if (baselines.has(visitor)) assert.deepEqual(response.json, baselines.get(visitor))
        else baselines.set(visitor, response.json)
      }
      assertPreserved(before)
    }
  })

  await t.test('reading an inactive video does not register a first view, like or new activity', async () => {
    const before = snapshot()
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const response = await request(`/api/videos/${pristineId}`, { headers: { 'X-Visitor-Id': otherVisitor } })
      assert.equal(response.status, 200)
      assert.equal(response.json.viewCount, 0)
      assert.equal(response.json.likeCount, 0)
      assert.equal(response.json.likedByMe, false)
      assert.equal(response.json.createdAt, createdAt)
      assert.equal(response.json.updatedAt, updatedAt)
    }
    assertPreserved(before)
  })

  await t.test('successful detail reads work with SQLite writes disabled on the shared connection', async () => {
    const before = snapshot()
    database.exec('PRAGMA query_only = ON')
    try {
      assert.equal(database.prepare('PRAGMA query_only').get().query_only, 1)
      for (const id of [fixture.videoId, pristineId]) {
        for (const headers of [{}, { 'X-Visitor-Id': visitorId }]) {
          const response = await request(`/api/videos/${id}`, { headers })
          assert.equal(response.status, 200)
          assert.equal(response.json.id, id)
        }
      }
      assertPreserved(before)
    } finally {
      database.exec('PRAGMA query_only = OFF')
    }
    assert.equal(database.prepare('PRAGMA query_only').get().query_only, 0)
  })

  await t.test('rejected input and missing-video reads leave the same persistent state intact', async () => {
    const before = snapshot()
    for (const [path, headers, status] of [
      ['/api/videos/0', {}, 400],
      [`/api/videos/${fixture.videoId}`, { 'X-Visitor-Id': 'invalid-visitor' }, 400],
      [`/api/videos/${fixture.videoId}`, { 'X-Visitor-Id': [visitorId, visitorId] }, 400],
      ['/api/videos/999999', {}, 404],
    ]) {
      const response = await request(path, { headers })
      assert.equal(response.status, status)
    }
    assertPreserved(before)
  })

  await t.test('failed database reads and subsequent recovery do not leave partial state or transactions behind', async subtest => {
    const before = snapshot()
    const log = subtest.mock.method(console, 'error', () => {})
    const fault = subtest.mock.method(database, 'prepare', () => { throw new Error('Injected detail read failure') })
    try {
      for (let iteration = 0; iteration < 2; iteration += 1) {
        const response = await request(`/api/videos/${fixture.videoId}`)
        assert.equal(response.status, 500)
        assert.deepEqual(response.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
      }
    } finally {
      fault.mock.restore()
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR'], ['INTERNAL_ERROR']])
    assertPreserved(before)
    assert.equal((await request(`/api/videos/${fixture.videoId}`)).status, 200)
    assertPreserved(before)
  })
})
