import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { countVideos } from '../../src/db/video-page-queries.js'
import { withTransaction } from '../../src/db/transaction.js'
import { loadVideoList } from '../../src/services/video-read.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']
const videoPath = 'videos/10000000-0000-4000-8000-000000000001.mp4'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('video-tag-total.db')
  context.initialize(path)
  return { context, path, database: context.open(path) }
}

function seed(database) {
  const fixture = insertMinimalFixture(database)
  database.prepare('UPDATE videos SET video_path = ? WHERE id = ?').run(videoPath, fixture.videoId)
  const otherTagId = database.prepare('INSERT INTO tags (name) VALUES (?)').run('Other tag').lastInsertRowid
  const unusedTagId = database.prepare('INSERT INTO tags (name) VALUES (?)').run('Unused tag').lastInsertRowid
  for (const id of [9, 3, 7, 5]) {
    database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(id, 'Filtered total video ' + id, videoPath)
  }
  const link = database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
  for (const id of [3, 7]) link.run(id, fixture.tagId)
  for (const id of [3, 5, 7, 9]) link.run(id, otherTagId)
  return { ...fixture, otherTagId, unusedTagId }
}

function snapshot(database, path) {
  return {
    rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }
}

test('filtered totals count matching videos once and remain independent of page size and empty final pages', t => {
  const { database, path } = setup(t)
  assert.equal(countVideos(database, { tagId: 1 }), 0)
  const { tagId, otherTagId, unusedTagId } = seed(database)
  database.exec('PRAGMA query_only = ON')
  const before = snapshot(database, path)
  assert.equal(countVideos(database), 5)
  assert.equal(countVideos(database, { tagId: null }), 5)
  assert.equal(countVideos(database, { tagId }), 3)
  assert.equal(countVideos(database, { tagId: otherTagId }), 4)
  for (const selected of [unusedTagId, Number.MAX_SAFE_INTEGER]) assert.equal(countVideos(database, { tagId: selected }), 0)
  for (const [page, limit, ids] of [[1, 1, [7]], [2, 2, [1]], [1, 50, [7, 3, 1]], [4, 1, []], [Number.MAX_SAFE_INTEGER, 50, []]]) {
    const result = loadVideoList(database, { page, limit, tagId })
    assert.equal(result.total, 3)
    assert.deepEqual(result.data.map(video => video.id), ids)
  }
  assert.deepEqual(snapshot(database, path), before)
  assert.equal(database.isTransaction, false)
})

test('tag counts bind the maximum safe tag ID rather than embedding it in SQL', t => {
  const { database, path } = setup(t)
  seed(database)
  const tagId = Number.MAX_SAFE_INTEGER
  database.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(tagId, 'Boundary count tag')
  database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(3, tagId)
  const before = snapshot(database, path)
  const prepare = database.prepare.bind(database)
  const calls = []
  const observed = t.mock.method(database, 'prepare', sql => {
    const statement = prepare(sql)
    const get = statement.get.bind(statement)
    t.mock.method(statement, 'get', (...params) => {
      calls.push({ sql, params })
      return get(...params)
    })
    return statement
  })
  assert.equal(countVideos(database, { tagId }), 1)
  observed.mock.restore()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].params, [tagId])
  assert.equal(calls[0].sql.includes(String(tagId)), false)
  assert.deepEqual(snapshot(database, path), before)
})

test('filtered count, page membership and shared Video data retain one snapshot when tag links change after counting', t => {
  const { database, context, path } = setup(t)
  const { tagId, visitorId } = seed(database)
  const options = { page: 2, limit: 2, tagId, visitorId }
  const expected = loadVideoList(database, options)
  assert.equal(expected.total, 3)
  assert.deepEqual(expected.data.map(video => video.id), [1])
  assert.equal(database.prepare('PRAGMA journal_mode = WAL').get().journal_mode, 'wal')
  const writer = context.open(path)
  database.exec('PRAGMA query_only = ON')
  const prepare = database.prepare.bind(database)
  let changed = false
  const observed = t.mock.method(database, 'prepare', sql => {
    assert.equal(database.isTransaction, true)
    const statement = prepare(sql)
    if (sql.includes('COUNT(*) AS total')) {
      const get = statement.get.bind(statement)
      t.mock.method(statement, 'get', (...params) => {
        const row = get(...params)
        assert.deepEqual(params, [tagId])
        withTransaction(writer, connection => {
          connection.prepare('DELETE FROM video_tags WHERE tag_id = ?').run(tagId)
          connection.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(9, tagId)
        })
        changed = true
        assert.equal(countVideos(writer, { tagId }), 1)
        return row
      })
    }
    return statement
  })
  try {
    assert.deepEqual(loadVideoList(database, options), expected)
    assert.equal(changed, true)
  } finally {
    observed.mock.restore()
  }
  const current = loadVideoList(database, { ...options, page: 1 })
  assert.equal(current.total, 1)
  assert.deepEqual(current.data.map(video => video.id), [9])
  assert.equal(database.isOpen, true)
  assert.equal(database.isTransaction, false)
})

test('the public video list applies normalized tags to page data and total together', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const { tagId, otherTagId, unusedTagId, visitorId } = seed(database)

  async function assertPage(query, { ids, total, page = 1, limit = 20 }, visitor = null) {
    const before = snapshot(database, databasePath)
    const response = await request('/api/videos' + query, { headers: visitor === null ? {} : { 'X-Visitor-Id': visitor.toUpperCase() } })
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.deepEqual(Object.keys(response.json).sort(), ['data', 'limit', 'page', 'total'])
    assert.equal(response.json.total, total)
    assert.equal(response.json.page, page)
    assert.equal(response.json.limit, limit)
    assert.deepEqual(response.json.data.map(video => video.id), ids)
    for (const video of response.json.data) {
      const detail = await request('/api/videos/' + video.id, { headers: visitor === null ? {} : { 'X-Visitor-Id': visitor } })
      assert.equal(detail.status, 200)
      assert.deepEqual(video, detail.json)
    }
    assert.deepEqual(snapshot(database, databasePath), before)
    assert.equal(database.isOpen, true)
    assert.equal(database.isTransaction, false)
    return response.json.data
  }

  await t.test('normalized tag pages retain the filtered total and all shared fields for anonymous and visitor reads', async () => {
    const first = await assertPage(`?tagId=000${tagId}&limit=2`, { ids: [7, 3], total: 3, limit: 2 })
    for (const video of first) assert.deepEqual(video.tags.map(tag => tag.id), [tagId, otherTagId])
    const last = await assertPage(`?tagId=000${tagId}&page=0002&limit=0002`, { ids: [1], total: 3, page: 2, limit: 2 }, visitorId)
    assert.equal(last[0].likedByMe, true)
    assert.equal(last[0].likeCount, 1)
    assert.equal(last[0].viewCount, 1)
    assert.equal(last[0].commentCount, 1)
    assert.equal(last[0].hasQuiz, true)
    await assertPage(`?tagId=${tagId}&page=3&limit=2`, { ids: [], total: 3, page: 3, limit: 2 })
    await assertPage(`?tagId=${tagId}&page=${Number.MAX_SAFE_INTEGER}&limit=50`, { ids: [], total: 3, page: Number.MAX_SAFE_INTEGER, limit: 50 })
  })

  await t.test('unused and missing tags return zero while other tags and omitted filters keep their own totals', async () => {
    for (const selected of [unusedTagId, Number.MAX_SAFE_INTEGER]) {
      await assertPage('?tagId=' + selected, { ids: [], total: 0 })
    }
    await assertPage('?tagId=' + otherTagId, { ids: [9, 7, 5, 3], total: 4 })
    await assertPage('', { ids: [9, 7, 5, 3, 1], total: 5 })
  })

  await t.test('a filtered count execution failure rolls back and returns the safe error before a successful retry', async subtest => {
    const before = snapshot(database, databasePath)
    const log = subtest.mock.method(console, 'error', () => {})
    const prepare = database.prepare.bind(database)
    const fault = subtest.mock.method(database, 'prepare', sql => {
      const statement = prepare(sql)
      if (sql.includes('COUNT(*) AS total')) subtest.mock.method(statement, 'get', () => {
        throw new Error('SELECT private_password_hash at C:/private/app.db with private-session')
      })
      return statement
    })
    try {
      const response = await request('/api/videos?tagId=' + tagId)
      assert.equal(response.status, 500)
      assert.deepEqual(response.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
      assert.equal(response.headers['set-cookie'], undefined)
      assert.equal(database.isTransaction, false)
      assert.equal(database.isOpen, true)
    } finally {
      fault.mock.restore()
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
    assert.deepEqual(snapshot(database, databasePath), before)
    await assertPage('?tagId=' + tagId, { ids: [7, 3, 1], total: 3 })
  })

  await t.test('subsequent tag link and video changes update both membership and filtered totals', async () => {
    database.prepare('DELETE FROM video_tags WHERE video_id = ? AND tag_id = ?').run(3, tagId)
    await assertPage('?tagId=' + tagId, { ids: [7, 1], total: 2 })
    database.prepare('DELETE FROM videos WHERE id = ?').run(7)
    await assertPage('?tagId=' + tagId, { ids: [1], total: 1 })
    database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(9, tagId)
    await assertPage('?tagId=' + tagId, { ids: [9, 1], total: 2 })
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
  })
})
