import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { withTransaction } from '../../src/db/transaction.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const visitorA = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const visitorB = '12345678-abcd-4abc-9def-012345abcdef'
const createdAt = '2001-02-03T04:05:06.000Z'
const updatedAt = '2002-03-04T05:06:07.000Z'
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('repeated view POST requests count each normalized video and visitor pair only once and preserve existing state', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const fixture = insertMinimalFixture(database)
  let freshId
  withTransaction(database, connection => {
    connection.prepare('UPDATE videos SET video_path = ?, created_at = ?, updated_at = ? WHERE id = ?')
      .run('videos/10000000-0000-4000-8000-000000000001.mp4', createdAt, updatedAt, fixture.videoId)
    connection.prepare('UPDATE video_views SET visitor_id = ?, created_at = ? WHERE video_id = ?')
      .run(visitorB, createdAt, fixture.videoId)
    freshId = connection.prepare('INSERT INTO videos (title, video_path, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('Fresh repeated target', 'videos/10000000-0000-4000-8000-000000000002.webm', createdAt, updatedAt).lastInsertRowid
  })

  function snapshot() {
    return {
      tables: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
      schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
      hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
    }
  }

  function assertPreserved(before) {
    assert.deepEqual(snapshot(), before)
    assert.equal(database.isTransaction, false)
    assert.equal(database.isOpen, true)
  }

  async function post(id, visitorId, options = {}) {
    const response = await request(`/api/videos/${id}/view` + (options.query ?? ''), {
      method: 'POST', cookie: options.cookie,
      headers: { 'X-Visitor-Id': visitorId, ...options.headers },
    })
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    return response.json
  }

  await t.test('a new pair returns true once and case or leading-zero retries return false without any further DB change', async () => {
    const before = snapshot()
    const first = await post(freshId, visitorA)
    assert.deepEqual(first, { videoId: freshId, viewCount: 1, counted: true })
    const saved = snapshot()
    for (const table of tables.filter(table => table !== 'video_views')) {
      assert.deepEqual(saved.tables[table], before.tables[table])
    }
    assert.deepEqual(saved.schema, before.schema)
    const isNewPair = row => row.video_id === freshId && row.visitor_id === visitorA
    assert.equal(saved.tables.video_views.filter(isNewPair).length, 1)
    assert.deepEqual(saved.tables.video_views.filter(row => !isNewPair(row)), before.tables.video_views)

    const counted = [first.counted]
    const mixed = [...visitorA].map((character, index) => index % 2 === 0 ? character.toUpperCase() : character).join('')
    for (let iteration = 0; iteration < 3; iteration += 1) {
      for (const [id, visitor] of [[freshId, visitorA], ['000' + freshId, visitorA.toUpperCase()], [freshId, mixed]]) {
        const repeated = await post(id, visitor)
        assert.deepEqual(repeated, { videoId: freshId, viewCount: 1, counted: false })
        counted.push(repeated.counted)
        assertPreserved(saved)
      }
    }
    assert.equal(counted.filter(value => value === true).length, 1)
    assert.equal(counted.filter(value => value === false).length, 9)
  })

  await t.test('a pair that existed before the HTTP calls is never counted again and keeps its original row and timestamp', async () => {
    const before = snapshot()
    const original = before.tables.video_views.find(row => row.video_id === fixture.videoId && row.visitor_id === visitorB)
    assert.equal(original.created_at, createdAt)
    for (let iteration = 0; iteration < 3; iteration += 1) {
      for (const visitor of [visitorB, visitorB.toUpperCase()]) {
        assert.deepEqual(await post('000' + fixture.videoId, visitor),
          { videoId: fixture.videoId, viewCount: 1, counted: false })
        assertPreserved(before)
      }
    }
  })

  await t.test('GETs and reconnecting retries with different cookies or queries reuse the header identity', async () => {
    const before = snapshot()
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const list = await request('/api/videos')
      assert.equal(list.status, 200)
      assert.deepEqual(list.json.data.map(video => [video.id, video.viewCount]), [[freshId, 1], [fixture.videoId, 1]])
      const detail = await request('/api/videos/' + freshId)
      assert.equal(detail.status, 200)
      assert.equal(detail.json.viewCount, 1)
      assert.equal(detail.json.createdAt, createdAt)
      assert.equal(detail.json.updatedAt, updatedAt)
      assert.deepEqual(await post(freshId, visitorA.toUpperCase(), {
        headers: { Connection: 'close' }, query: '?visitorId=' + visitorB,
        cookie: 'visitorId=' + visitorB + '; admin_session=invalid',
      }), { videoId: freshId, viewCount: 1, counted: false })
      assertPreserved(before)
    }
  })
})
