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

test('repeated like PUT requests preserve one normalized pair and always return the committed liked state', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const fixture = insertMinimalFixture(database)
  let freshId
  withTransaction(database, connection => {
    connection.prepare('UPDATE videos SET video_path = ?, created_at = ?, updated_at = ? WHERE id = ?')
      .run('videos/10000000-0000-4000-8000-000000000001.mp4', createdAt, updatedAt, fixture.videoId)
    connection.prepare('UPDATE video_likes SET visitor_id = ?, created_at = ? WHERE video_id = ?')
      .run(visitorB, createdAt, fixture.videoId)
    freshId = connection.prepare('INSERT INTO videos (title, video_path, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('Fresh repeated like target', 'videos/10000000-0000-4000-8000-000000000002.webm', createdAt, updatedAt).lastInsertRowid
  })

  function snapshot() {
    return {
      rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
      schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
      hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
    }
  }

  function assertReady() {
    assert.equal(database.isTransaction, false)
    assert.equal(database.isOpen, true)
  }

  function assertPreserved(before) {
    assert.deepEqual(snapshot(), before)
    assertReady()
  }

  async function put(id, visitorId, { query = '', ...options } = {}) {
    const response = await request(`/api/videos/${id}/like` + query, { method: 'PUT', ...options,
      headers: { 'X-Visitor-Id': visitorId, ...options.headers },
    })
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assertReady()
    return response.json
  }

  await t.test('the first PUT adds one row and nine normalized retries preserve that row and the entire database file', async () => {
    const before = snapshot()
    assert.deepEqual(await put(freshId, visitorA), { videoId: freshId, likeCount: 1, likedByMe: true })
    const saved = snapshot()
    const pair = row => row.video_id === freshId && row.visitor_id === visitorA
    assert.equal(saved.rows.video_likes.filter(pair).length, 1)
    assert.deepEqual(saved.rows.video_likes.filter(row => !pair(row)), before.rows.video_likes)
    for (const table of tables.filter(table => table !== 'video_likes')) {
      assert.deepEqual(saved.rows[table], before.rows[table])
    }
    assert.deepEqual(saved.schema, before.schema)
    const mixed = [...visitorA].map((character, index) => index % 2 === 0 ? character.toUpperCase() : character).join('')
    for (let round = 0; round < 3; round += 1) {
      for (const [id, visitor] of [[freshId, visitorA], ['000' + freshId, visitorA.toUpperCase()], [freshId, mixed]]) {
        assert.deepEqual(await put(id, visitor), { videoId: freshId, likeCount: 1, likedByMe: true })
        assertPreserved(saved)
      }
    }
  })

  await t.test('six PUTs for a previously registered pair preserve its old timestamp, row identity and all other data', async () => {
    const before = snapshot()
    const original = before.rows.video_likes.find(row => row.video_id === fixture.videoId && row.visitor_id === visitorB)
    assert.equal(original.created_at, createdAt)
    for (let round = 0; round < 3; round += 1) {
      for (const visitor of [visitorB, visitorB.toUpperCase()]) {
        assert.deepEqual(await put('000' + fixture.videoId, visitor),
          { videoId: fixture.videoId, likeCount: 1, likedByMe: true })
        assertPreserved(before)
      }
    }
  })

  await t.test('GETs and reconnecting retries keep the same header identity despite alternate body, query and cookie values', async () => {
    const before = snapshot()
    for (let round = 0; round < 3; round += 1) {
      const list = await request('/api/videos', { headers: { 'X-Visitor-Id': visitorA.toUpperCase() } })
      assert.equal(list.status, 200)
      assert.deepEqual(list.json.data.map(video => [video.id, video.likeCount, video.likedByMe]),
        [[freshId, 1, true], [fixture.videoId, 1, false]])
      const detail = await request('/api/videos/' + freshId, { headers: { 'X-Visitor-Id': visitorA } })
      assert.equal(detail.status, 200)
      assert.equal(detail.json.likeCount, 1)
      assert.equal(detail.json.likedByMe, true)
      assert.equal(detail.json.createdAt, createdAt)
      assert.equal(detail.json.updatedAt, updatedAt)
      assert.deepEqual(await put(freshId, visitorA.toUpperCase(), {
        headers: { Connection: 'close' }, body: { visitorId: visitorB }, query: '?visitorId=' + visitorB,
        cookie: 'visitorId=' + visitorB + '; admin_session=invalid',
      }), { videoId: freshId, likeCount: 1, likedByMe: true })
      assertPreserved(before)
    }
  })
})
