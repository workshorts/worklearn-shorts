import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { withTransaction } from '../../src/db/transaction.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const visitorA = 'aabbccdd-eeff-4abc-8def-012345abcdee'
const visitorB = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const visitorC = 'aabbccdd-eeff-4abc-8def-012345abcded'
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('like mutations isolate complete visitor UUIDs and video pairs across actual HTTP requests', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const fixture = insertMinimalFixture(database)
  const otherIds = [2, Number.MAX_SAFE_INTEGER]
  withTransaction(database, connection => {
    connection.prepare('UPDATE videos SET video_path = ? WHERE id = ?')
      .run('videos/10000000-0000-4000-8000-000000000001.mp4', fixture.videoId)
    connection.prepare('UPDATE video_likes SET visitor_id = ?, created_at = ? WHERE video_id = ?')
      .run(visitorB, '2001-02-03T04:05:06.000Z', fixture.videoId)
    for (const [index, id] of otherIds.entries()) {
      connection.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
        .run(id, 'Visitor isolation target ' + index, `videos/20000000-0000-4000-8000-00000000000${index}.mp4`)
      connection.prepare('INSERT INTO video_likes (video_id, visitor_id, created_at) VALUES (?, ?, ?)')
        .run(id, visitorB, '2002-03-04T05:06:07.000Z')
      connection.prepare('INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)').run(id, visitorA)
    }
  })
  let mutations = 0
  let reads = 0

  function snapshot() {
    return {
      rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
      schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
      hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
    }
  }

  function assertOnlyPairsChanged(before, allowed) {
    const after = snapshot()
    for (const table of tables.filter(table => table !== 'video_likes')) {
      assert.deepEqual(after.rows[table], before.rows[table])
    }
    assert.deepEqual(after.rows.video_likes.filter(row => !allowed(row)), before.rows.video_likes.filter(row => !allowed(row)))
    assert.deepEqual(after.schema, before.schema)
    assert.equal(database.isOpen, true)
    assert.equal(database.isTransaction, false)
    return after
  }

  async function assertVisitorRead(id, visitorId) {
    const before = snapshot()
    const count = database.prepare('SELECT COUNT(*) AS count FROM video_likes WHERE video_id = ?').get(id).count
    const own = database.prepare('SELECT COUNT(*) AS count FROM video_likes WHERE video_id = ? AND visitor_id = ?')
      .get(id, visitorId).count
    assert.ok(own === 0 || own === 1)
    const response = await request('/api/videos/' + id, { headers: { 'X-Visitor-Id': visitorId.toUpperCase() } })
    reads += 1
    assert.equal(response.status, 200)
    assert.equal(response.json.id, id)
    assert.equal(response.json.likeCount, count)
    assert.equal(response.json.likedByMe, own === 1)
    assert.deepEqual(snapshot(), before)
  }

  async function change(id, visitorId, method, { query = '', ...options } = {}) {
    const before = snapshot()
    const normalized = visitorId.toLowerCase()
    const pair = row => row.video_id === id && row.visitor_id === normalized
    const oldRows = before.rows.video_likes.filter(pair)
    const response = await request(`/api/videos/000${id}/like` + query, {
      ...options, method, headers: { ...options.headers, 'X-Visitor-Id': visitorId },
    })
    mutations += 1
    const after = assertOnlyPairsChanged(before, pair)
    const ownRows = after.rows.video_likes.filter(pair)
    assert.equal(ownRows.length, method === 'PUT' ? 1 : 0)
    assert.equal(response.status, 200)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.deepEqual(response.json, { videoId: id,
      likeCount: after.rows.video_likes.filter(row => row.video_id === id).length, likedByMe: method === 'PUT' })
    // Retrying an existing addition or an absent deletion cannot rewrite any row or timestamp.
    if ((method === 'PUT' && oldRows.length === 1) || (method === 'DELETE' && oldRows.length === 0)) {
      assert.deepEqual(after, before)
    }
  }

  await t.test('alternating near-identical UUIDs preserves the other visitor after every addition and cancellation', async () => {
    for (const [visitor, method] of [
      [visitorA, 'PUT'], [visitorB, 'PUT'], [visitorB, 'DELETE'], [visitorB, 'PUT'],
      [visitorA, 'DELETE'], [visitorA, 'PUT'], [visitorA, 'DELETE'], [visitorA, 'PUT'],
    ]) {
      await change(fixture.videoId, visitor.toUpperCase(), method)
      await assertVisitorRead(fixture.videoId, visitorA)
      await assertVisitorRead(fixture.videoId, visitorB)
    }
  })

  await t.test('the same visitor on another video and the safe-integer boundary remains a separate pair', async () => {
    for (const id of otherIds) {
      for (const [visitor, method] of [[visitorA, 'PUT'], [visitorB, 'DELETE'], [visitorA, 'DELETE'], [visitorB, 'PUT']]) {
        await change(id, visitor, method)
        await assertVisitorRead(id, visitorA)
        await assertVisitorRead(id, visitorB)
      }
    }
  })

  await t.test('body, query and cookie identities cannot replace the required header identity', async () => {
    for (const method of ['PUT', 'DELETE']) {
      await change(fixture.videoId, visitorC.toUpperCase(), method, {
        body: { visitorId: visitorA }, query: '?visitorId=' + visitorA,
        cookie: 'visitorId=' + visitorA + '; admin_session=invalid', headers: { Connection: 'close' },
      })
      await assertVisitorRead(fixture.videoId, visitorC)
      await assertVisitorRead(fixture.videoId, visitorA)
      for (const headers of [{}, { 'X-Visitor-Id': 'invalid' }, { 'X-Visitor-Id': [visitorA, visitorB] }]) {
        const before = snapshot()
        const response = await request(`/api/videos/${fixture.videoId}/like?visitorId=${visitorB}`, {
          method, headers, body: { visitorId: visitorB }, cookie: 'visitorId=' + visitorB,
        })
        mutations += 1
        assert.equal(response.status, 400)
        assert.equal(response.json.code, 'VALIDATION_ERROR')
        assert.deepEqual(snapshot(), before)
      }
    }
  })

  await t.test('overlapping requests from eight visitors create independent pairs and cancel only the selected visitors', async () => {
    const visitors = Array.from({ length: 8 }, (_, index) => 'c0ffee00-0000-4000-8000-' + String(index + 1).padStart(12, '0'))
    const id = fixture.videoId
    const protectedRows = snapshot()
    for (const [method, selected] of [['PUT', visitors], ['PUT', visitors], ['DELETE', visitors.filter((_, index) => index % 2 === 0)],
      ['DELETE', visitors.filter((_, index) => index % 2 === 0)]]) {
      const before = snapshot()
      const responses = await Promise.all(selected.map(visitor => request(`/api/videos/${id}/like`, {
        method, headers: { 'X-Visitor-Id': visitor.toUpperCase(), Connection: 'close' },
      })))
      mutations += selected.length
      const after = assertOnlyPairsChanged(before, row => row.video_id === id && selected.includes(row.visitor_id))
      for (const response of responses) {
        assert.equal(response.status, 200)
        assert.deepEqual(Object.keys(response.json).sort(), ['likeCount', 'likedByMe', 'videoId'])
        assert.equal(response.json.videoId, id)
        assert.equal(response.json.likedByMe, method === 'PUT')
        assert.ok(Number.isInteger(response.json.likeCount) && response.json.likeCount >= 2 && response.json.likeCount <= 10)
      }
      for (const [index, visitor] of visitors.entries()) {
        const own = after.rows.video_likes.filter(row => row.video_id === id && row.visitor_id === visitor)
        assert.equal(own.length, method === 'PUT' || index % 2 !== 0 ? 1 : 0)
        await assertVisitorRead(id, visitor)
      }
      if ((method === 'PUT' && before.rows.video_likes.length === after.rows.video_likes.length) ||
          (method === 'DELETE' && selected.every(visitor => !before.rows.video_likes.some(row => row.video_id === id && row.visitor_id === visitor)))) {
        assert.deepEqual(after, before)
      }
    }
    assertOnlyPairsChanged(protectedRows, row => row.video_id === id && visitors.includes(row.visitor_id))
  })

  assert.equal(mutations, 48)
  assert.equal(reads, 68)
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})
