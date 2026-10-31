import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const visitorA = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const visitorC = '12345678-abcd-4abc-9def-012345abcdef'
const visitorD = 'fedcba98-7654-4abc-bdef-012345abcdef'
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']
const messages = {
  id: 'ID는 1 이상 9007199254740991 이하의 정수로 입력하세요.',
  page: '페이지는 1 이상 9007199254740991 이하의 정수로 입력하세요.',
  limit: '페이지당 항목 수는 1 이상 50 이하의 정수로 입력하세요.',
  tagId: 'tagId는 1 이상 9007199254740991 이하의 정수로 입력하세요.',
  visitorId: '방문자 ID는 올바른 UUID 형식으로 입력하세요.',
}
const internal = { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} }
const missing = { code: 'NOT_FOUND', message: '영상을 찾을 수 없습니다.', fields: {} }
const validation = field => ({ code: 'VALIDATION_ERROR', message: '입력값을 확인하세요.', fields: { [field]: messages[field] } })

function privateFailure() {
  // Untrusted database errors must not acquire public status, fields or headers from lookalike properties.
  return Object.assign(new Error('SELECT password_hash FROM C:/private/app.db with private-session', {
    cause: new Error('private-cause'),
  }), { status: 404, code: 'NOT_FOUND', fields: { privateSecret: 'private-value' }, headers: { 'X-Private': 'private-header' } })
}

test('the basic public APIs share safe 400, 404 and 500 contracts and recover without partial writes', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const fixture = insertMinimalFixture(database)
  database.prepare('UPDATE videos SET video_path = ? WHERE id = ?')
    .run('videos/10000000-0000-4000-8000-000000000001.mp4', fixture.videoId)
  const writes = [
    { method: 'POST', suffix: 'view', table: 'video_views' },
    { method: 'PUT', suffix: 'like', table: 'video_likes' },
    { method: 'DELETE', suffix: 'like', table: 'video_likes' },
  ]
  const reads = [{ method: 'GET', path: '/api/tags' },
    { method: 'GET', path: '/api/videos?tagId=' + fixture.tagId },
    { method: 'GET', path: '/api/videos/' + fixture.videoId }]
  const pathFor = (route, id = fixture.videoId) => route.path ?? `/api/videos/${id}/${route.suffix}`
  let rejected = 0
  let recovered = 0

  function snapshot() {
    return {
      rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
      schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
      hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
    }
  }

  function assertReady() {
    assert.equal(database.isOpen, true)
    assert.equal(database.isTransaction, false)
  }

  async function reject(path, options, status, body) {
    const response = await request(path, options)
    assert.equal(response.status, status)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.equal(response.headers['x-private'], undefined)
    assert.deepEqual(response.json, body)
    assert.doesNotMatch(response.text, /private|password_hash|SELECT|app\.db|stack|cause/)
    assert.doesNotMatch(JSON.stringify(response.headers), /private|password_hash|app\.db/)
    assertReady()
    rejected += 1
  }

  async function retry(route, visitor = visitorA) {
    const before = snapshot()
    const response = await request(pathFor(route), { method: route.method, headers: { 'X-Visitor-Id': visitor.toUpperCase() } })
    assert.equal(response.status, 200)
    assert.equal(response.headers['set-cookie'], undefined)
    if (route.method === 'GET') {
      if (route.path === '/api/tags') assert.deepEqual(response.json, { data: [{ id: fixture.tagId, name: 'Fixture tag' }] })
      else if (route.path.startsWith('/api/videos?')) {
        assert.equal(response.json.total, 1)
        assert.deepEqual(response.json.data.map(video => video.id), [fixture.videoId])
      } else assert.equal(response.json.id, fixture.videoId)
      assert.deepEqual(snapshot(), before)
    } else {
      const count = before.rows[route.table].length + (route.method === 'DELETE' ? -1 : 1)
      assert.deepEqual(response.json, route.suffix === 'view'
        ? { videoId: fixture.videoId, viewCount: count, counted: true }
        : { videoId: fixture.videoId, likeCount: count, likedByMe: route.method === 'PUT' })
      const after = snapshot()
      const pair = row => row.video_id === fixture.videoId && row.visitor_id === visitor
      assert.equal(after.rows[route.table].filter(pair).length, route.method === 'DELETE' ? 0 : 1)
      assert.deepEqual(after.rows[route.table].filter(row => !pair(row)), before.rows[route.table].filter(row => !pair(row)))
      for (const table of tables.filter(table => table !== route.table)) assert.deepEqual(after.rows[table], before.rows[table])
      assert.deepEqual(after.schema, before.schema)
    }
    assertReady()
    recovered += 1
  }

  async function withoutSql(subtest, check) {
    const before = snapshot()
    const prepare = database.prepare.bind(database)
    const exec = database.exec.bind(database)
    const prepared = subtest.mock.method(database, 'prepare', (...args) => prepare(...args))
    const executed = subtest.mock.method(database, 'exec', (...args) => exec(...args))
    const log = subtest.mock.method(console, 'error', () => {})
    try {
      await check()
      assert.equal(prepared.mock.callCount(), 0)
      assert.equal(executed.mock.callCount(), 0)
      assert.deepEqual(log.mock.calls.map(call => call.arguments), [])
    } finally {
      prepared.mock.restore()
      executed.mock.restore()
    }
    assert.deepEqual(snapshot(), before)
  }

  await t.test('invalid IDs, list filters and visitor headers share exact field errors before database access', async subtest => {
    await withoutSql(subtest, async () => {
      for (const id of ['0', 'abc', '9007199254740992']) {
        await reject('/api/videos/' + id, {}, 400, validation('id'))
        for (const route of writes) await reject(pathFor(route, id), {
          method: route.method, headers: { 'X-Visitor-Id': visitorA },
        }, 400, validation('id'))
      }
      for (const [query, field] of [['page=0', 'page'], ['limit=51', 'limit'], ['tagId=0', 'tagId'], ['tagId=1&tagId=2', 'tagId']]) {
        await reject('/api/videos?' + query, {}, 400, validation(field))
      }
      for (const path of ['/api/videos', '/api/videos/' + fixture.videoId]) {
        await reject(path, { headers: { 'X-Visitor-Id': 'invalid' } }, 400, validation('visitorId'))
      }
      for (const route of writes) {
        for (const headers of [{}, { 'X-Visitor-Id': 'invalid' }, { 'X-Visitor-Id': [visitorA, visitorA] }]) {
          await reject(pathFor(route), { method: route.method, headers }, 400, validation('visitorId'))
        }
      }
    })
  })

  await t.test('valid absent videos share the resource-specific 404 across detail, view, addition and cancellation', async subtest => {
    const before = snapshot()
    const log = subtest.mock.method(console, 'error', () => {})
    for (const id of [999999, Number.MAX_SAFE_INTEGER]) {
      await reject('/api/videos/' + id, {}, 404, missing)
      for (const route of writes) await reject(pathFor(route, id), {
        method: route.method, headers: { 'X-Visitor-Id': visitorA },
      }, 404, missing)
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [])
    assert.deepEqual(snapshot(), before)
  })

  await t.test('malformed JSON on the three write methods shares INVALID_JSON without echoing the body or using SQL', async subtest => {
    await withoutSql(subtest, async () => {
      for (const route of writes) await reject(pathFor(route), {
        method: route.method, headers: { 'X-Visitor-Id': visitorA }, body: '{"private_password":',
      }, 400, { code: 'INVALID_JSON', message: 'JSON 형식이 올바르지 않습니다.', fields: {} })
    })
  })

  await t.test('all six APIs hide untrusted database error properties and recover after lookup failures', async subtest => {
    const log = subtest.mock.method(console, 'error', () => {})
    for (const route of [...reads, ...writes]) {
      const before = snapshot()
      const fault = subtest.mock.method(database, 'prepare', () => { throw privateFailure() })
      try {
        await reject(pathFor(route), { method: route.method, headers: { 'X-Visitor-Id': visitorA } }, 500, internal)
        assert.equal(fault.mock.callCount(), 1)
      } finally {
        fault.mock.restore()
      }
      assert.deepEqual(snapshot(), before)
      await retry(route)
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), Array.from({ length: 6 }, () => ['INTERNAL_ERROR']))
  })

  await t.test('aggregation errors after actual insertions and deletion roll back each write before returning the safe 500', async subtest => {
    const log = subtest.mock.method(console, 'error', () => {})
    for (const route of writes) {
      const before = snapshot()
      const prepare = database.prepare.bind(database)
      let reached = false
      const fault = subtest.mock.method(database, 'prepare', sql => {
        if (sql.startsWith('SELECT COUNT(*)')) {
          assert.equal(database.isTransaction, true)
          const row = prepare(`SELECT visitor_id FROM ${route.table} WHERE video_id = ? AND visitor_id = ?`)
            .get(fixture.videoId, visitorC)
          assert.equal(row !== undefined, route.method !== 'DELETE')
          reached = true
          throw privateFailure()
        }
        return prepare(sql)
      })
      try {
        await reject(pathFor(route), { method: route.method, headers: { 'X-Visitor-Id': visitorC } }, 500, internal)
      } finally {
        fault.mock.restore()
      }
      assert.equal(reached, true)
      assert.deepEqual(snapshot(), before)
      await retry(route, visitorC)
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), Array.from({ length: 3 }, () => ['INTERNAL_ERROR']))
  })

  await t.test('failed commits never return partial success and restore original rows before normal retries', async subtest => {
    const log = subtest.mock.method(console, 'error', () => {})
    for (const route of writes) {
      const before = snapshot()
      const exec = database.exec.bind(database)
      const commands = []
      let reached = false
      const fault = subtest.mock.method(database, 'exec', sql => {
        commands.push(sql)
        if (sql === 'COMMIT') {
          assert.equal(database.isTransaction, true)
          const row = database.prepare(`SELECT visitor_id FROM ${route.table} WHERE video_id = ? AND visitor_id = ?`)
            .get(fixture.videoId, visitorD)
          assert.equal(row !== undefined, route.method !== 'DELETE')
          reached = true
          throw privateFailure()
        }
        return exec(sql)
      })
      try {
        await reject(pathFor(route), { method: route.method, headers: { 'X-Visitor-Id': visitorD } }, 500, internal)
      } finally {
        fault.mock.restore()
      }
      assert.deepEqual(commands, ['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK'])
      assert.equal(reached, true)
      assert.deepEqual(snapshot(), before)
      await retry(route, visitorD)
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), Array.from({ length: 3 }, () => ['INTERNAL_ERROR']))
  })

  assert.equal(rejected, 50)
  assert.equal(recovered, 12)
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})
