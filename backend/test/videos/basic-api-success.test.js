import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { withTransaction } from '../../src/db/transaction.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const visitorA = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const createdAt = '2001-02-03T04:05:06.000Z'
const updatedAt = '2002-03-04T05:06:07.000Z'
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('the six basic public APIs preserve the specified success contract throughout one visitor workflow', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const covered = new Set()
  const state = { viewCount: 1, likeCount: 1, likedByA: false }
  let fixture
  let emptyId
  let alphaId
  let unusedId

  function snapshot() {
    return {
      rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
      schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
      hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
    }
  }

  async function call(path, options = {}) {
    covered.add((options.method ?? 'GET') + ' ' + path.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id'))
    const response = await request(path, options)
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.equal(database.isOpen, true)
    assert.equal(database.isTransaction, false)
    return response.json
  }

  function expectedVideo(id, visitor) {
    if (id === emptyId) return {
      id, title: 'Empty contract video', description: '', tags: [],
      videoUrl: '/uploads/videos/20000000-0000-4000-8000-000000000002.webm',
      thumbnailUrl: '/images/default-thumbnail.svg', viewCount: 0, likeCount: 0,
      likedByMe: false, commentCount: 0, hasQuiz: false, createdAt, updatedAt,
    }
    return {
      id, title: 'Populated contract video', description: 'Public contract description',
      tags: [{ id: alphaId, name: 'Alpha' }, { id: fixture.tagId, name: 'Zulu' }],
      videoUrl: '/uploads/videos/10000000-0000-4000-8000-000000000001.mp4',
      thumbnailUrl: '/uploads/thumbnails/10000000-0000-4000-8000-000000000001.png',
      viewCount: state.viewCount, likeCount: state.likeCount,
      likedByMe: visitor === visitorA ? state.likedByA : visitor === fixture.visitorId,
      commentCount: 1, hasQuiz: true, createdAt, updatedAt,
    }
  }

  function assertVideo(video, expected) {
    // The complete expected object follows API U2/U3; no production DTO builder supplies expected values.
    assert.deepEqual(video, expected)
    assert.equal(Object.keys(video).length, 13)
    assert.equal(Number.isSafeInteger(video.id) && video.id > 0, true)
    for (const field of ['viewCount', 'likeCount', 'commentCount']) {
      assert.equal(Number.isSafeInteger(video[field]) && video[field] >= 0, true)
    }
    for (const field of ['title', 'description', 'videoUrl', 'thumbnailUrl', 'createdAt', 'updatedAt']) {
      assert.equal(typeof video[field], 'string')
    }
    for (const field of ['likedByMe', 'hasQuiz']) assert.equal(typeof video[field], 'boolean')
    for (const field of ['createdAt', 'updatedAt']) {
      assert.match(video[field], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      assert.equal(new Date(video[field]).toISOString(), video[field])
    }
  }

  async function readState(visitor = null) {
    const before = snapshot()
    const options = { headers: visitor === null ? {} : { 'X-Visitor-Id': visitor.toUpperCase() } }
    const list = await call('/api/videos', options)
    const expected = [expectedVideo(emptyId, visitor), expectedVideo(fixture.videoId, visitor)]
    assert.deepEqual(list, { data: expected, page: 1, limit: 20, total: 2 })
    for (const [index, id] of [emptyId, fixture.videoId].entries()) {
      assertVideo(list.data[index], expected[index])
      assertVideo(await call('/api/videos/000' + id, options), expected[index])
    }
    assert.deepEqual(snapshot(), before)
  }

  async function write(method, suffix, expected, table, noChange = false) {
    const before = snapshot()
    const body = await call(`/api/videos/000${fixture.videoId}/${suffix}`, {
      method, headers: { 'X-Visitor-Id': visitorA.toUpperCase(), Origin: 'https://other.example.test' },
      cookie: 'admin_session=invalid',
    })
    assert.deepEqual(body, expected)
    assert.equal(typeof body.videoId, 'number')
    const countField = suffix === 'view' ? 'viewCount' : 'likeCount'
    const flagField = suffix === 'view' ? 'counted' : 'likedByMe'
    assert.equal(Number.isSafeInteger(body[countField]) && body[countField] >= 0, true)
    assert.equal(typeof body[flagField], 'boolean')
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE video_id = ?`).get(fixture.videoId).count, body[countField])
    const pair = row => row.video_id === fixture.videoId && row.visitor_id === visitorA
    const after = snapshot()
    assert.equal(after.rows[table].filter(pair).length, method === 'DELETE' ? 0 : 1)
    assert.deepEqual(after.rows[table].filter(row => !pair(row)), before.rows[table].filter(row => !pair(row)))
    for (const other of tables.filter(name => name !== table)) assert.deepEqual(after.rows[other], before.rows[other])
    assert.deepEqual(after.schema, before.schema)
    if (noChange) assert.deepEqual(after, before)
    if (suffix === 'view') state.viewCount = expected.viewCount
    else { state.likeCount = expected.likeCount; state.likedByA = expected.likedByMe }
    await readState(visitorA)
  }

  await t.test('empty tag and video collections use 200 and their distinct array envelopes', async () => {
    const before = snapshot()
    assert.deepEqual(await call('/api/tags'), { data: [] })
    assert.deepEqual(await call('/api/videos'), { data: [], page: 1, limit: 20, total: 0 })
    assert.deepEqual(snapshot(), before)
  })

  await t.test('list and detail share all thirteen fields with correct populated, empty and anonymous values', async () => {
    fixture = insertMinimalFixture(database)
    withTransaction(database, connection => {
      connection.prepare('UPDATE videos SET title = ?, description = ?, video_path = ?, thumbnail_path = ?, created_at = ?, updated_at = ? WHERE id = ?')
        .run('Populated contract video', 'Public contract description', 'videos/10000000-0000-4000-8000-000000000001.mp4',
          'thumbnails/10000000-0000-4000-8000-000000000001.png', createdAt, updatedAt, fixture.videoId)
      connection.prepare('UPDATE tags SET name = ? WHERE id = ?').run('Zulu', fixture.tagId)
      const insertTag = connection.prepare('INSERT INTO tags (name) VALUES (?)')
      alphaId = insertTag.run('Alpha').lastInsertRowid
      unusedId = insertTag.run('Unused').lastInsertRowid
      connection.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(fixture.videoId, alphaId)
      emptyId = connection.prepare('INSERT INTO videos (title, video_path, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('Empty contract video', 'videos/20000000-0000-4000-8000-000000000002.webm', createdAt, updatedAt).lastInsertRowid
    })
    for (const visitor of [null, visitorA, fixture.visitorId]) await readState(visitor)
    const before = snapshot()
    assert.deepEqual(await call('/api/videos?page=3&limit=1'), { data: [], page: 3, limit: 1, total: 2 })
    assert.deepEqual(snapshot(), before)
  })

  await t.test('the tag endpoint returns only data with id and name items in name order including unused tags', async () => {
    const before = snapshot()
    assert.deepEqual(await call('/api/tags'), { data: [
      { id: alphaId, name: 'Alpha' }, { id: unusedId, name: 'Unused' }, { id: fixture.tagId, name: 'Zulu' },
    ] })
    assert.deepEqual(snapshot(), before)
  })

  await t.test('view POST uses numeric IDs and counts with a boolean true only on the first committed recording', async () => {
    await write('POST', 'view', { videoId: fixture.videoId, viewCount: 2, counted: true }, 'video_views')
    await write('POST', 'view', { videoId: fixture.videoId, viewCount: 2, counted: false }, 'video_views', true)
  })

  await t.test('like PUT returns true and a committed numeric count on both new and repeated additions', async () => {
    await write('PUT', 'like', { videoId: fixture.videoId, likeCount: 2, likedByMe: true }, 'video_likes')
    await write('PUT', 'like', { videoId: fixture.videoId, likeCount: 2, likedByMe: true }, 'video_likes', true)
  })

  await t.test('like DELETE returns false and a committed numeric count on both existing and absent pairs', async () => {
    await write('DELETE', 'like', { videoId: fixture.videoId, likeCount: 1, likedByMe: false }, 'video_likes')
    await write('DELETE', 'like', { videoId: fixture.videoId, likeCount: 1, likedByMe: false }, 'video_likes', true)
    await readState(fixture.visitorId)
    await readState()
  })

  assert.deepEqual([...covered].sort(), ['GET /api/tags', 'GET /api/videos', 'GET /api/videos/:id',
    'POST /api/videos/:id/view', 'PUT /api/videos/:id/like', 'DELETE /api/videos/:id/like'].sort())
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})
