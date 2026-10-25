import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const timestampColumns = {
  admins: ['created_at'],
  videos: ['created_at', 'updated_at'],
  courses: ['created_at', 'updated_at'],
  video_views: ['created_at'],
  video_likes: ['created_at'],
  comments: ['created_at'],
  quizzes: ['created_at', 'updated_at']
}
const clockSql = "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS value"
const timestampQuery = Object.entries(timestampColumns).flatMap(([table, columns]) => columns.map(column =>
  `SELECT '${table}.${column}' AS name, ${column} AS value FROM ${table}`
)).join(' UNION ALL ')

function assertUtcTimestamp(value, before, after, name) {
  assert.equal(typeof value, 'string', name)
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, name)
  const milliseconds = Date.parse(value)
  assert.equal(Number.isFinite(milliseconds), true, name)
  assert.equal(new Date(milliseconds).toISOString(), value, name)
  assert.ok(milliseconds >= Date.parse(before) && milliseconds <= Date.parse(after),
    `${name} must be generated between the UTC clock readings around insertion`)
}

for (const [table, columns] of Object.entries(timestampColumns)) {
  test(`${table} omitted timestamps default to the current millisecond UTC time`, { timeout: 10000 }, t => {
    const context = createDatabaseContext(t)
    const path = context.path('timestamps.db')
    context.initialize(path)
    const database = context.open(path)
    // Use the same SQLite clock for both bounds to avoid cross-clock millisecond drift.
    const before = database.prepare(clockSql).get().value
    insertMinimalFixture(database)
    const after = database.prepare(clockSql).get().value
    const rows = database.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all()
    assert.equal(rows.length, 1)

    for (const column of columns) {
      assertUtcTimestamp(rows[0][column], before, after, `${table}.${column}`)
    }

    if (columns.includes('updated_at')) {
      assert.equal(rows[0].created_at, rows[0].updated_at)
    }
  })
}

test('timestamp defaults stay UTC in a non-UTC process and persist after reopening', { timeout: 30000 }, t => {
  const context = createDatabaseContext(t)
  const path = context.path('non-utc.db')
  const initializationUrl = new URL('../../src/db/initialization.js', import.meta.url).href
  const connectionUrl = new URL('../../src/db/connection.js', import.meta.url).href
  const fixtureUrl = new URL('../helpers/minimal-fixture.js', import.meta.url).href
  const code = [
    `import { initializeDatabase } from ${JSON.stringify(initializationUrl)}`,
    `import { openExistingDatabase, closeDatabase } from ${JSON.stringify(connectionUrl)}`,
    `import { insertMinimalFixture } from ${JSON.stringify(fixtureUrl)}`,
    'initializeDatabase(process.env.DB_PATH)',
    'const database = openExistingDatabase(process.env.DB_PATH)',
    'let result',
    'try {',
    `  const before = database.prepare(${JSON.stringify(clockSql)}).get().value`,
    '  insertMinimalFixture(database)',
    `  const after = database.prepare(${JSON.stringify(clockSql)}).get().value`,
    `  const rows = database.prepare(${JSON.stringify(timestampQuery)}).all()`,
    "  const sqliteOffset = database.prepare(\"SELECT (julianday('now', 'localtime') - julianday('now')) * 1440 AS minutes\").get().minutes",
    '  result = { before, after, rows, nodeOffset: new Date().getTimezoneOffset(), sqliteOffset }',
    '} finally { closeDatabase(database) }',
    'console.log(JSON.stringify({ ...result, closed: !database.isOpen }))'
  ].join('\n')
  // This TZ form also changes SQLite's C runtime local clock on Windows.
  const environment = { ...process.env, DB_PATH: path, TZ: 'EST5EDT' }
  delete environment.NODE_TEST_CONTEXT
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: context.directory,
    env: environment,
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true
  })
  assert.equal(child.error, undefined, child.error?.message)
  assert.equal(child.signal, null, child.stderr)
  assert.equal(child.status, 0, child.stderr)
  const result = JSON.parse(child.stdout)
  assert.equal(result.closed, true)
  assert.ok([240, 300].includes(result.nodeOffset))
  assert.ok(Math.abs(result.sqliteOffset) > 1, 'SQLite local time must also differ from UTC')
  assert.equal(result.rows.length, 10)
  const expectedNames = Object.entries(timestampColumns).flatMap(([table, columns]) =>
    columns.map(column => `${table}.${column}`))
  assert.deepEqual(result.rows.map(row => row.name), expectedNames)

  for (const { name, value } of result.rows) {
    assertUtcTimestamp(value, result.before, result.after, name)
  }

  const reopened = context.open(path)
  const stored = reopened.prepare(timestampQuery).all().map(row => ({ ...row }))
  assert.deepEqual(stored, result.rows)
})
