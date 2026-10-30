import assert from 'node:assert/strict'
import test from 'node:test'
import { withTransaction } from '../../src/db/transaction.js'
import { startAuthServer } from '../helpers/auth-server.js'

test('video list GET preserves the page contract for empty data, page boundaries and large valid offsets', { timeout: 30000 }, async t => {
  const { request, getDb } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const orderedIds = Array.from({ length: 51 }, (_, index) => (51 - index) * 3)

  async function expectPage(query, { page, limit, total, ids }, headers = {}) {
    const response = await request('/api/videos' + query, { headers })
    assert.equal(response.status, 200, query)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.deepEqual(Object.keys(response.json).sort(), ['data', 'limit', 'page', 'total'])
    assert.equal(response.json.page, page)
    assert.equal(response.json.limit, limit)
    assert.equal(response.json.total, total)
    assert.ok(Array.isArray(response.json.data))
    assert.deepEqual(response.json.data.map(video => video.id), ids)
    return response.json.data.map(video => video.id)
  }

  await t.test('an empty database returns JSON 200 with an empty array and zero total for anonymous and visitor requests', async () => {
    for (const headers of [{}, { 'X-Visitor-Id': 'AABBCCDD-EEFF-4ABC-8DEF-012345ABCDEF' }]) {
      for (const [query, page, limit] of [['', 1, 20], ['?page=2&limit=1', 2, 1],
        ['?limit=50', 1, 50], [`?page=${Number.MAX_SAFE_INTEGER}&limit=49`, Number.MAX_SAFE_INTEGER, 49],
        [`?page=${Number.MAX_SAFE_INTEGER}&limit=50`, Number.MAX_SAFE_INTEGER, 50]]) {
        await expectPage(query, { page, limit, total: 0, ids: [] }, headers)
      }
    }
  })

  // Deliberately insert sparse IDs out of order and give every row the same timestamp.
  withTransaction(database, connection => {
    const insert = connection.prepare('INSERT INTO videos (id, title, video_path, created_at) VALUES (?, ?, ?, ?)')
    for (const id of [...orderedIds.slice(17), ...orderedIds.slice(0, 17)]) {
      insert.run(id, 'Boundary video ' + id, 'videos/10000000-0000-4000-8000-000000000001.mp4',
        '2000-01-01T00:00:00.000Z')
    }
  })

  await t.test('default pages contain 20, 20 and 11 videos without duplication or omission and retain total on the next empty page', async () => {
    const received = []
    for (const [page, ids] of [[1, orderedIds.slice(0, 20)], [2, orderedIds.slice(20, 40)],
      [3, orderedIds.slice(40)], [4, []]]) {
      received.push(...await expectPage('?page=' + page, { page, limit: 20, total: 51, ids }))
    }
    assert.deepEqual(received, orderedIds)
    assert.equal(new Set(received).size, 51)
  })

  await t.test('limit one returns the newest and final video exactly and keeps total after the last page', async () => {
    for (const [page, ids] of [[1, [153]], [51, [3]], [52, []]]) {
      await expectPage(`?page=${page}&limit=1`, { page, limit: 1, total: 51, ids })
    }
  })

  await t.test('limit fifty returns fifty videos and then the final one without clamping, overlap or a changed total', async () => {
    const first = await expectPage('?limit=50', { page: 1, limit: 50, total: 51, ids: orderedIds.slice(0, 50) })
    const last = await expectPage('?page=2&limit=50', { page: 2, limit: 50, total: 51, ids: [3] })
    await expectPage('?page=3&limit=50', { page: 3, limit: 50, total: 51, ids: [] })
    assert.deepEqual([...first, ...last], orderedIds)
  })

  await t.test('large valid pages serialize their original numeric page and total with an empty array instead of an internal error', async () => {
    for (const [page, limit] of [[Number.MAX_SAFE_INTEGER, 1], [Number.MAX_SAFE_INTEGER, 49],
      [Number.MAX_SAFE_INTEGER, 50], [183820392953900, 49]]) {
      await expectPage(`?page=${page}&limit=${limit}`, { page, limit, total: 51, ids: [] })
    }
  })
})
