import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { closeDatabase, openExistingDatabase } from '../../src/db/connection.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const visitorA = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const visitorB = '12345678-abcd-4abc-9def-012345abcdef'
const visitorC = 'fedcba98-7654-4abc-bdef-012345abcdef'
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('HTTP view recording isolates visitors and returns safe failures for native SQLite errors with recovery', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const fixture = insertMinimalFixture(database)
  database.prepare('UPDATE videos SET video_path = ? WHERE id = ?')
    .run('videos/10000000-0000-4000-8000-000000000001.mp4', fixture.videoId)
  const otherId = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Independent HTTP view target', 'videos/10000000-0000-4000-8000-000000000002.webm').lastInsertRowid

  function snapshot() {
    return {
      tables: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
      schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
      hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
    }
  }

  function post(id, visitorId) {
    return request(`/api/videos/${id}/view`, { method: 'POST', headers: { 'X-Visitor-Id': visitorId } })
  }

  function count(id) {
    return database.prepare('SELECT COUNT(*) AS count FROM video_views WHERE video_id = ?').get(id).count
  }

  function assertSuccess(response, videoId, viewCount, counted) {
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.deepEqual(response.json, { videoId, viewCount, counted })
    assert.equal(database.isOpen, true)
    assert.equal(database.isTransaction, false)
  }

  async function assertRecovery(id, visitorId) {
    const before = count(id)
    assertSuccess(await post(id, visitorId), id, before + 1, true)
    const saved = snapshot()
    assertSuccess(await post(id, visitorId.toUpperCase()), id, before + 1, false)
    assert.deepEqual(snapshot(), saved)
  }

  async function assertNativeFailure(subtest, id, visitorId, stage, errcode) {
    const before = snapshot()
    const observed = []
    function observe(operationStage, operation) {
      try { return operation() }
      catch (error) { observed.push({ stage: operationStage, error }); throw error }
    }
    const log = subtest.mock.method(console, 'error', () => {})
    const exec = database.exec.bind(database)
    const prepare = database.prepare.bind(database)
    // These wrappers observe the actual native exception; they do not inject one.
    const execObserver = subtest.mock.method(database, 'exec', (sql, ...args) =>
      observe(sql === 'BEGIN IMMEDIATE' ? 'begin' : sql, () => exec(sql, ...args)))
    const prepareObserver = subtest.mock.method(database, 'prepare', (sql, ...args) => {
      const statement = observe('prepare', () => prepare(sql, ...args))
      if (sql.startsWith('INSERT INTO video_views')) {
        const run = statement.run.bind(statement)
        statement.run = (...params) => observe('insert', () => run(...params))
      }
      return statement
    })
    let response
    try {
      response = await post(id, visitorId)
    } finally {
      prepareObserver.mock.restore()
      execObserver.mock.restore()
      log.mock.restore()
    }
    assert.equal(response.status, 500)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.deepEqual(response.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
    assert.equal(observed.length, 1)
    assert.equal(observed[0].stage, stage)
    assert.equal(observed[0].error.code, 'ERR_SQLITE_ERROR')
    assert.equal(observed[0].error.errcode, errcode)
    assert.equal(database.isTransaction, false)
    assert.equal(database.isOpen, true)
    assert.deepEqual(snapshot(), before)
  }

  await t.test('different normalized UUIDs increase only their target count while returning visitors remain duplicates', async () => {
    const before = snapshot()
    for (const [visitor, expected] of [[visitorA, 2], [visitorB, 3], [visitorC, 4]]) {
      assertSuccess(await post(fixture.videoId, visitor), fixture.videoId, expected, true)
    }
    for (const visitor of [visitorA, visitorB, visitorC]) {
      assertSuccess(await post(fixture.videoId, visitor.toUpperCase()), fixture.videoId, 4, false)
    }
    assertSuccess(await post(otherId, visitorA), otherId, 1, true)
    assertSuccess(await post(otherId, visitorB), otherId, 2, true)
    assertSuccess(await post(otherId, visitorA.toUpperCase()), otherId, 2, false)
    assertSuccess(await post(otherId, visitorB.toUpperCase()), otherId, 2, false)
    const saved = snapshot()
    assert.deepEqual(saved.tables.video_views.map(row => [row.video_id, row.visitor_id]),
      [[fixture.videoId, fixture.visitorId], [fixture.videoId, visitorA], [fixture.videoId, visitorB],
        [fixture.videoId, visitorC], [otherId, visitorA], [otherId, visitorB]])
    assert.deepEqual(saved.tables.video_views[0], before.tables.video_views[0])
    for (const table of tables.filter(table => table !== 'video_views')) {
      assert.deepEqual(saved.tables[table], before.tables[table])
    }
    assert.deepEqual(saved.schema, before.schema)
    const list = await request('/api/videos')
    assert.equal(list.status, 200)
    assert.deepEqual(list.json.data.map(video => [video.id, video.viewCount]), [[otherId, 2], [fixture.videoId, 4]])
    for (const [id, expected] of [[fixture.videoId, 4], [otherId, 2]]) {
      const detail = await request('/api/videos/' + id)
      assert.equal(detail.status, 200)
      assert.equal(detail.json.viewCount, expected)
    }
    assert.deepEqual(snapshot(), saved)
  })

  await t.test('a native unique constraint outside the composite key returns 500 while the true duplicate still returns false', async subtest => {
    // The partial index belongs only to this owned DB and adds an unrelated constraint.
    database.exec(`CREATE UNIQUE INDEX test_view_visitor_unique ON video_views(visitor_id) WHERE visitor_id = '${visitorC}'`)
    try {
      const before = snapshot()
      assertSuccess(await post(fixture.videoId, visitorC), fixture.videoId, 4, false)
      assert.deepEqual(snapshot(), before)
      await assertNativeFailure(subtest, otherId, visitorC, 'insert', 2067)
    } finally {
      database.exec('DROP INDEX test_view_visitor_unique')
    }
    await assertRecovery(otherId, visitorC)
  })

  const triggerCases = [
    { name: 'foreign-key', visitor: '00000000-0000-4000-8000-000000000004', code: 787,
      sql: 'INSERT INTO video_tags (video_id, tag_id) VALUES (NEW.video_id, -1);' },
    { name: 'not-null', visitor: '00000000-0000-4000-8000-000000000005', code: 1299,
      sql: 'UPDATE video_views SET visitor_id = NULL WHERE video_id = NEW.video_id AND visitor_id = NEW.visitor_id;' },
  ]
  for (const scenario of triggerCases) {
    await t.test(`a native ${scenario.name} error after insertion rolls back the view and earlier trigger changes before retry`, async subtest => {
      // Mutate another table first so a swallowed error or partial rollback is visible.
      database.exec(`CREATE TRIGGER test_view_failure AFTER INSERT ON video_views
        WHEN NEW.visitor_id = '${scenario.visitor}' BEGIN
          UPDATE videos SET title = 'private-trigger-change' WHERE id = NEW.video_id;
          ${scenario.sql}
        END`)
      try {
        await assertNativeFailure(subtest, otherId, scenario.visitor, 'insert', scenario.code)
      } finally {
        database.exec('DROP TRIGGER test_view_failure')
      }
      await assertRecovery(otherId, scenario.visitor)
    })
  }

  await t.test('native read-only failure at BEGIN returns 500 and disabling query-only restores a new insertion', async subtest => {
    const visitor = '00000000-0000-4000-8000-000000000006'
    database.exec('PRAGMA query_only = ON')
    try {
      await assertNativeFailure(subtest, otherId, visitor, 'begin', 8)
    } finally {
      database.exec('PRAGMA query_only = OFF')
    }
    assert.equal(database.prepare('PRAGMA query_only').get().query_only, 0)
    await assertRecovery(otherId, visitor)
  })

  await t.test('a native busy error from another connection returns 500 and cannot roll back the other owner before recovery', async subtest => {
    const visitor = '00000000-0000-4000-8000-000000000007'
    const locker = openExistingDatabase(databasePath)
    try {
      // Fail fast only in this case; restore the production five-second timeout below.
      database.exec('PRAGMA busy_timeout = 0')
      locker.exec('BEGIN IMMEDIATE')
      await assertNativeFailure(subtest, otherId, visitor, 'begin', 5)
      assert.equal(locker.isTransaction, true)
    } finally {
      if (locker.isTransaction) locker.exec('ROLLBACK')
      closeDatabase(locker)
      database.exec('PRAGMA busy_timeout = 5000')
    }
    assert.equal(database.prepare('PRAGMA busy_timeout').get().timeout, 5000)
    await assertRecovery(otherId, visitor)
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
  })
})
