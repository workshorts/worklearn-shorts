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

test('repeated like DELETE requests keep the target pair absent and preserve all unrelated records', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const fixture = insertMinimalFixture(database)
  let targetId
  let emptyId
  withTransaction(database, connection => {
    connection.prepare('UPDATE videos SET video_path = ?, created_at = ?, updated_at = ? WHERE id = ?')
      .run('videos/10000000-0000-4000-8000-000000000001.mp4', createdAt, updatedAt, fixture.videoId)
    connection.prepare('UPDATE video_likes SET visitor_id = ?, created_at = ? WHERE video_id = ?')
      .run(visitorB, createdAt, fixture.videoId)
    const insertVideo = connection.prepare('INSERT INTO videos (title, video_path, created_at, updated_at) VALUES (?, ?, ?, ?)')
    targetId = insertVideo.run('Repeated cancel target', 'videos/10000000-0000-4000-8000-000000000002.webm', createdAt, updatedAt).lastInsertRowid
    emptyId = insertVideo.run('Never liked target', 'videos/10000000-0000-4000-8000-000000000003.mp4', createdAt, updatedAt).lastInsertRowid
    const insertLike = connection.prepare('INSERT INTO video_likes (video_id, visitor_id, created_at) VALUES (?, ?, ?)')
    for (const [id, visitor] of [[fixture.videoId, visitorA], [targetId, visitorA], [targetId, visitorB]]) {
      insertLike.run(id, visitor, createdAt)
    }
    connection.prepare('INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)').run(targetId, visitorA)
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

  async function cancel(id, visitorId, { query = '', ...options } = {}) {
    const response = await request(`/api/videos/${id}/like` + query, { method: 'DELETE', ...options,
      headers: { 'X-Visitor-Id': visitorId, ...options.headers },
    })
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assertReady()
    return response.json
  }

  await t.test('the first DELETE removes one pair and nine normalized retries preserve every remaining row and the database file', async () => {
    const before = snapshot()
    const target = row => row.video_id === targetId && row.visitor_id === visitorA
    assert.equal(before.rows.video_likes.filter(target).length, 1)
    assert.deepEqual(await cancel(targetId, visitorA), { videoId: targetId, likeCount: 1, likedByMe: false })
    const saved = snapshot()
    assert.deepEqual(saved.rows.video_likes, before.rows.video_likes.filter(row => !target(row)))
    for (const table of tables.filter(table => table !== 'video_likes')) {
      assert.deepEqual(saved.rows[table], before.rows[table])
    }
    assert.deepEqual(saved.schema, before.schema)
    const mixed = [...visitorA].map((character, index) => index % 2 === 0 ? character.toUpperCase() : character).join('')
    for (let round = 0; round < 3; round += 1) {
      for (const [id, visitor] of [[targetId, visitorA], ['000' + targetId, visitorA.toUpperCase()], [targetId, mixed]]) {
        assert.deepEqual(await cancel(id, visitor), { videoId: targetId, likeCount: 1, likedByMe: false })
        assertPreserved(saved)
      }
    }
  })

  await t.test('six cancellations of a never-liked pair keep zero without touching likes on other videos', async () => {
    const before = snapshot()
    assert.equal(before.rows.video_likes.filter(row => row.video_id === emptyId).length, 0)
    for (let round = 0; round < 3; round += 1) {
      for (const visitor of [visitorA, visitorA.toUpperCase()]) {
        assert.deepEqual(await cancel('000' + emptyId, visitor),
          { videoId: emptyId, likeCount: 0, likedByMe: false })
        assertPreserved(before)
      }
    }
  })

  await t.test('GETs and reconnecting retries preserve absence and cannot cancel another identity from body, query or cookies', async () => {
    const before = snapshot()
    for (let round = 0; round < 3; round += 1) {
      const list = await request('/api/videos', { headers: { 'X-Visitor-Id': visitorA.toUpperCase() } })
      assert.equal(list.status, 200)
      assert.deepEqual(list.json.data.map(video => [video.id, video.likeCount, video.likedByMe]),
        [[emptyId, 0, false], [targetId, 1, false], [fixture.videoId, 2, true]])
      const detail = await request('/api/videos/' + targetId, { headers: { 'X-Visitor-Id': visitorA } })
      assert.equal(detail.status, 200)
      assert.equal(detail.json.likeCount, 1)
      assert.equal(detail.json.likedByMe, false)
      assert.equal(detail.json.createdAt, createdAt)
      assert.equal(detail.json.updatedAt, updatedAt)
      assert.deepEqual(await cancel(targetId, visitorA.toUpperCase(), {
        headers: { Connection: 'close' }, body: { visitorId: visitorB }, query: '?visitorId=' + visitorB,
        cookie: 'visitorId=' + visitorB + '; admin_session=invalid',
      }), { videoId: targetId, likeCount: 1, likedByMe: false })
      assertPreserved(before)
    }
  })
})
