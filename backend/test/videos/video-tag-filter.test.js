import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { withTransaction } from '../../src/db/transaction.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']
const videoPath = 'videos/10000000-0000-4000-8000-000000000001.mp4'

test('tag filtering preserves complete disjoint pages, overlapping memberships and validation boundaries over real HTTP', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const fixture = insertMinimalFixture(database)
  const alphaIds = [1, ...Array.from({ length: 50 }, (_, index) => (index + 1) * 4 + 1)]
  const otherIds = Array.from({ length: 52 }, (_, index) => (index + 1) * 4)
  const betaIds = [...alphaIds.filter((_, index) => index % 2 === 0), ...otherIds.filter((_, index) => index % 3 === 0)]
  const allIds = [...alphaIds, ...otherIds].sort((first, second) => second - first)
  let beta
  let gamma
  let unused
  const boundary = Number.MAX_SAFE_INTEGER
  withTransaction(database, connection => {
    connection.prepare('UPDATE videos SET video_path = ? WHERE id = ?').run(videoPath, fixture.videoId)
    connection.prepare('UPDATE tags SET name = ? WHERE id = ?').run('Alpha', fixture.tagId)
    const insertTag = connection.prepare('INSERT INTO tags (name) VALUES (?)')
    beta = insertTag.run('Beta').lastInsertRowid
    gamma = insertTag.run('Gamma').lastInsertRowid
    unused = insertTag.run('Delta').lastInsertRowid
    connection.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(boundary, 'Epsilon')
    const insertVideo = connection.prepare('INSERT INTO videos (id, title, video_path, created_at) VALUES (?, ?, ?, ?)')
    for (const id of [...otherIds, ...alphaIds.slice(1).reverse()]) {
      insertVideo.run(id, 'Filter verification video ' + id, videoPath, '2000-01-01T00:00:00.000Z')
    }
    const link = connection.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
    for (const id of alphaIds.slice(1)) link.run(id, fixture.tagId)
    for (const id of betaIds) link.run(id, beta)
    for (const id of allIds) link.run(id, gamma)
    link.run(fixture.videoId, boundary)
  })
  const ordered = ids => [...ids].sort((first, second) => second - first)
  const matches = new Map([[fixture.tagId, ordered(alphaIds)], [beta, ordered(betaIds)], [gamma, allIds],
    [boundary, [fixture.videoId]], [unused, []], [null, allIds]])
  const tagNames = new Map([[fixture.tagId, 'Alpha'], [beta, 'Beta'], [boundary, 'Epsilon'], [gamma, 'Gamma']])
  const members = new Map([[fixture.tagId, new Set(alphaIds)], [beta, new Set(betaIds)],
    [boundary, new Set([fixture.videoId])], [gamma, new Set(allIds)]])
  database.exec('PRAGMA query_only = ON')

  function snapshot() {
    return {
      rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
      schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
      hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
    }
  }

  function checkResponse(response, tagId, { page = 1, limit = 20, visitor = null } = {}) {
    const ids = matches.get(tagId) ?? []
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.deepEqual(Object.keys(response.json).sort(), ['data', 'limit', 'page', 'total'])
    assert.equal(response.json.page, page)
    assert.equal(response.json.limit, limit)
    assert.equal(response.json.total, ids.length)
    assert.deepEqual(response.json.data.map(video => video.id), ids.slice((page - 1) * limit, page * limit))
    for (const video of response.json.data) {
      const tags = [...tagNames].filter(([id]) => members.get(id).has(video.id)).map(([id, name]) => ({ id, name }))
      assert.deepEqual(video.tags, tags)
      assert.equal(video.likedByMe, visitor === fixture.visitorId && video.id === fixture.videoId)
      assert.equal(video.likeCount, video.id === fixture.videoId ? 1 : 0)
      assert.equal(video.videoUrl, '/uploads/' + videoPath)
    }
    assert.equal(database.isOpen, true)
    assert.equal(database.isTransaction, false)
    return response.json.data.map(video => video.id)
  }

  async function readPage(tagId, { query, ...options } = {}) {
    const { page = 1, limit = 20, visitor = null } = options
    const path = query ?? `?page=${page}&limit=${limit}` + (tagId === null ? '' : '&tagId=' + tagId)
    const before = snapshot()
    const response = await request('/api/videos' + path, {
      headers: visitor === null ? {} : { 'X-Visitor-Id': visitor.toUpperCase() },
    })
    const ids = checkResponse(response, tagId, options)
    assert.deepEqual(snapshot(), before)
    return ids
  }

  await t.test('all fifty-one matching videos cross default pages without missing or duplicate rows for anonymous and visitor requests', async () => {
    for (const visitor of [null, fixture.visitorId]) {
      const collected = []
      for (const page of [1, 2, 3, 4]) collected.push(...await readPage(fixture.tagId, { page, visitor }))
      assert.deepEqual(collected, ordered(alphaIds))
      assert.equal(new Set(collected).size, 51)
    }
  })

  await t.test('minimum and maximum limits retain filtered totals on partial and empty end pages', async () => {
    for (const page of [1, 51, 52]) await readPage(fixture.tagId, { page, limit: 1 })
    const first = await readPage(fixture.tagId, { limit: 50 })
    const last = await readPage(fixture.tagId, { page: 2, limit: 50 })
    await readPage(fixture.tagId, { page: 3, limit: 50 })
    assert.deepEqual([...first, ...last], ordered(alphaIds))
    assert.equal(new Set([...first, ...last]).size, 51)
    await readPage(fixture.tagId, { page: Number.MAX_SAFE_INTEGER, limit: 50 })
  })

  await t.test('overlapping tags, omitted filters, unused tags and normalized boundary IDs each select their own complete membership', async () => {
    for (const [tagId, limit] of [[beta, 20], [gamma, 50]]) {
      const collected = []
      for (const page of [1, 2, 3, 4]) collected.push(...await readPage(tagId, { page, limit }))
      assert.deepEqual(collected, matches.get(tagId))
      assert.equal(new Set(collected).size, matches.get(tagId).length)
    }
    await readPage(null, { limit: 50 })
    await readPage(unused)
    await readPage(boundary - 1)
    await readPage(boundary, { visitor: fixture.visitorId, query: `?tagId=000${boundary}&page=0001&limit=0020` })
    await readPage(boundary, { page: 2, limit: 1 })
  })

  await t.test('malformed and repeated tag values and invalid accompanying inputs return exact 400 errors before SQL', async subtest => {
    const before = snapshot()
    const prepare = database.prepare.bind(database)
    const exec = database.exec.bind(database)
    const prepared = subtest.mock.method(database, 'prepare', (...args) => prepare(...args))
    const executed = subtest.mock.method(database, 'exec', (...args) => exec(...args))
    const messages = {
      tagId: 'tagId는 1 이상 9007199254740991 이하의 정수로 입력하세요.',
      page: '페이지는 1 이상 9007199254740991 이하의 정수로 입력하세요.',
      limit: '페이지당 항목 수는 1 이상 50 이하의 정수로 입력하세요.',
      visitorId: '방문자 ID는 올바른 UUID 형식으로 입력하세요.',
    }
    try {
      const invalidTags = ['tagId', 'tagId=', 'tagId=0', 'tagId=-1', 'tagId=1.5', 'tagId=abc',
        'tagId=9007199254740992', 'tagId=1&tagId=1', 'tagId=1&tagId=2', 'tagId=1%2C2',
        'tagId=1%20OR%201%3D1', 'tagId=%EF%BC%91', 'tagId=%20']
      const cases = [...invalidTags.map(query => ({ query, field: 'tagId' })),
        { query: `tagId=${fixture.tagId}&page=0`, field: 'page' },
        { query: `tagId=${fixture.tagId}&limit=51`, field: 'limit' },
        { query: `tagId=${fixture.tagId}`, field: 'visitorId', headers: { 'X-Visitor-Id': 'invalid' } }]
      for (const { query, field, headers } of cases) {
        const response = await request('/api/videos?' + query, { headers })
        assert.equal(response.status, 400)
        assert.deepEqual(response.json, { code: 'VALIDATION_ERROR', message: '입력값을 확인하세요.', fields: { [field]: messages[field] } })
        assert.equal(response.headers['set-cookie'], undefined)
      }
      assert.equal(prepared.mock.callCount(), 0)
      assert.equal(executed.mock.callCount(), 0)
    } finally {
      prepared.mock.restore()
      executed.mock.restore()
    }
    assert.deepEqual(snapshot(), before)
  })

  await t.test('filtered pages keep bounded query counts as page size grows and skip Video loading for empty results', async subtest => {
    const before = snapshot()
    const prepare = database.prepare.bind(database)
    const exec = database.exec.bind(database)
    const calls = []
    const commands = []
    const prepared = subtest.mock.method(database, 'prepare', sql => {
      const statement = prepare(sql)
      for (const method of ['get', 'all', 'iterate', 'run']) {
        const original = statement[method].bind(statement)
        subtest.mock.method(statement, method, (...params) => {
          calls.push({ method, sql })
          return original(...params)
        })
      }
      return statement
    })
    const executed = subtest.mock.method(database, 'exec', sql => { commands.push(sql); return exec(sql) })
    try {
      for (const visitor of [null, fixture.visitorId]) {
        for (const [tagId, page, limit, maximum] of [[fixture.tagId, 1, 1, 4], [fixture.tagId, 1, 20, 4],
          [fixture.tagId, 1, 50, 4], [fixture.tagId, 4, 20, 2], [unused, 1, 20, 2]]) {
          calls.length = 0
          commands.length = 0
          const response = await request(`/api/videos?tagId=${tagId}&page=${page}&limit=${limit}`, {
            headers: visitor === null ? {} : { 'X-Visitor-Id': visitor },
          })
          checkResponse(response, tagId, { page, limit, visitor })
          assert.ok(calls.length > 0 && calls.length <= maximum)
          assert.ok(calls.every(call => call.method !== 'run'))
          assert.deepEqual(commands, ['BEGIN', 'COMMIT'])
        }
      }
    } finally {
      prepared.mock.restore()
      executed.mock.restore()
    }
    assert.deepEqual(snapshot(), before)
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
  })
})
