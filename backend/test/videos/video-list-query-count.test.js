import assert from 'node:assert/strict'
import test from 'node:test'
import { withTransaction } from '../../src/db/transaction.js'
import { startAuthServer } from '../helpers/auth-server.js'

const visitorId = 'aabbccdd-eeff-4abc-8def-012345abcdef'

test('video list GET keeps database query calls bounded independently of the number of returned videos', { timeout: 30000 }, async t => {
  const { request, getDb } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const prepared = []
  const executions = []
  const commands = []
  const prepare = database.prepare.bind(database)
  const exec = database.exec.bind(database)

  t.mock.method(database, 'prepare', sql => {
    prepared.push(sql)
    const statement = prepare(sql)
    // Count executions as well as preparation so reusing a statement cannot hide per-row queries.
    for (const method of ['get', 'all', 'iterate', 'run']) {
      if (typeof statement[method] !== 'function') continue
      const original = statement[method].bind(statement)
      t.mock.method(statement, method, (...params) => {
        executions.push({ sql, method })
        return original(...params)
      })
    }
    return statement
  })
  t.mock.method(database, 'exec', sql => {
    commands.push(sql)
    return exec(sql)
  })

  async function measure(query, headers = {}) {
    prepared.length = 0
    executions.length = 0
    commands.length = 0
    const response = await request('/api/videos' + query, { headers })
    return { response, prepared: [...prepared], executions: [...executions], commands: [...commands] }
  }

  function assertRead(result, { ids, total, maximum }) {
    assert.equal(result.response.status, 200)
    assert.equal(result.response.json.total, total)
    assert.deepEqual(result.response.json.data.map(video => video.id), ids)
    assert.ok(result.prepared.length <= maximum, 'Preparation must stay within the page query budget')
    assert.ok(result.executions.length > 0 && result.executions.length <= maximum,
      'Execution count must stay within the page query budget')
    assert.ok(result.executions.every(({ method }) => method !== 'run'))
    // This also prevents uncounted data queries through database.exec.
    assert.deepEqual(result.commands, ['BEGIN', 'COMMIT'])
    assert.equal(database.isTransaction, false)
  }

  await t.test('an empty database needs at most two query calls for anonymous and visitor requests', async () => {
    for (const headers of [{}, { 'X-Visitor-Id': visitorId }]) {
      const result = await measure('', headers)
      assertRead(result, { ids: [], total: 0, maximum: 2 })
      t.diagnostic(`Empty page query executions: ${result.executions.length}`)
    }
  })

  withTransaction(database, connection => {
    const tagInsert = connection.prepare('INSERT INTO tags (name) VALUES (?)')
    const tagIds = [tagInsert.run('Alpha').lastInsertRowid, tagInsert.run('Beta').lastInsertRowid]
    const videoInsert = connection.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    const tagLink = connection.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
    const viewInsert = connection.prepare('INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)')
    const likeInsert = connection.prepare('INSERT INTO video_likes (video_id, visitor_id) VALUES (?, ?)')
    const commentInsert = connection.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)')
    const quizInsert = connection.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)')
    const optionInsert = connection.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
    for (let index = 0; index < 51; index += 1) {
      const id = videoInsert.run('Counted video ' + index,
        'videos/10000000-0000-4000-8000-000000000001.mp4').lastInsertRowid
      for (const tagId of tagIds) tagLink.run(id, tagId)
      viewInsert.run(id, visitorId)
      likeInsert.run(id, visitorId)
      commentInsert.run(id, 'Test visitor', 'test-only-placeholder', 'Test comment')
      const quizId = quizInsert.run(id, 'Test question?').lastInsertRowid
      optionInsert.run(quizId, 'Correct option', 1, 1)
      optionInsert.run(quizId, 'Other option', 2, 0)
    }
  })

  await t.test('pages of one, twenty and fifty populated videos use the same bounded query count with and without a visitor', async () => {
    const counts = []
    for (const limit of [1, 20, 50]) {
      for (const headers of [{}, { 'X-Visitor-Id': visitorId }]) {
        const result = await measure('?limit=' + limit, headers)
        assertRead(result, {
          ids: Array.from({ length: limit }, (_, index) => 51 - index), total: 51, maximum: 4,
        })
        for (const video of result.response.json.data) {
          assert.equal(video.tags.length, 2)
          assert.equal(video.viewCount, 1)
          assert.equal(video.likeCount, 1)
          assert.equal(video.commentCount, 1)
          assert.equal(video.hasQuiz, true)
          assert.equal(video.likedByMe, Object.hasOwn(headers, 'X-Visitor-Id'))
        }
        counts.push(result.executions.length)
      }
    }
    assert.equal(new Set(counts).size, 1, 'Returning more videos must not add database query calls')
    t.diagnostic(`Page query executions for limits 1/20/50, anonymous/visitor: ${counts.join(', ')}`)
  })

  await t.test('a partial final page stays within four calls while pages beyond the end need at most two', async () => {
    const last = await measure('?page=2&limit=50', { 'X-Visitor-Id': visitorId })
    assertRead(last, { ids: [1], total: 51, maximum: 4 })
    for (const query of ['?page=3&limit=50', `?page=${Number.MAX_SAFE_INTEGER}&limit=50`]) {
      assertRead(await measure(query), { ids: [], total: 51, maximum: 2 })
    }
  })

  await t.test('rejected list inputs execute no database statements or transaction commands', async () => {
    for (const [query, headers] of [['?page=0', {}], ['?limit=51', {}],
      ['', { 'X-Visitor-Id': [visitorId, visitorId] }]]) {
      const result = await measure(query, headers)
      assert.equal(result.response.status, 400)
      assert.equal(result.response.json.code, 'VALIDATION_ERROR')
      assert.deepEqual(result.prepared, [])
      assert.deepEqual(result.executions, [])
      assert.deepEqual(result.commands, [])
    }
  })
})
