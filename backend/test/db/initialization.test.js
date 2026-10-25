import assert from 'node:assert/strict'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'
import { closeDatabase } from '../../src/db/connection.js'
import { verifyDatabaseSchema } from '../../src/db/schema-validation.js'

// Assert the initialization result without deriving expectations from schema.sql.
const expectedTables = ['admins', 'comments', 'course_videos', 'courses', 'quiz_options',
  'quizzes', 'tags', 'video_likes', 'video_tags', 'video_views', 'videos']

function assertFreshDatabase(context, path) {
  assert.equal(lstatSync(path).isFile(), true)
  assert.equal(readFileSync(path).subarray(0, 16).toString('ascii'), 'SQLite format 3\0')

  for (const suffix of ['-journal', '-wal', '-shm']) {
    assert.equal(existsSync(path + suffix), false)
  }

  const database = context.open(path)
  const tables = database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name"
  ).all().map(row => row.name)
  assert.deepEqual(tables, expectedTables)
  let columnCount = 0

  for (const table of expectedTables) {
    columnCount += database.prepare('SELECT count(*) AS count FROM pragma_table_xinfo(?)').get(table).count
    assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0)
  }

  assert.equal(columnCount, 45)
  assert.deepEqual(verifyDatabaseSchema(database), { tableCount: 11, columnCount: 45 })
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
}

test('first initialization creates missing parents and a complete empty database', { timeout: 10000 }, t => {
  const context = createDatabaseContext(t)
  const path = context.path('new', 'nested', 'app.db')
  assert.equal(existsSync(path), false)
  assert.equal(existsSync(dirname(path)), false)

  assert.deepEqual(context.initialize(path), { databasePath: path })
  assert.equal(lstatSync(dirname(path)).isDirectory(), true)
  assertFreshDatabase(context, path)
})

function runInitializationCli(context, path) {
  const entry = fileURLToPath(new URL('../../db/init.js', import.meta.url))
  const environment = { ...process.env, DB_PATH: path }
  delete environment.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [entry], {
    cwd: context.directory,
    env: environment,
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true
  })

  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.signal, null, result.stderr)
  return result
}

test('first CLI initialization succeeds from another cwd and persists the complete schema', { timeout: 30000 }, t => {
  const context = createDatabaseContext(t)
  const path = context.path('새 DB # %', 'app.db')
  assert.equal(existsSync(path), false)
  const result = runInitializationCli(context, path)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'Database initialized successfully.')
  assert.doesNotMatch(result.stderr, /Database initialization (?:failed|refused):/)
  assertFreshDatabase(context, path)
})

function snapshotContents(context, path) {
  const database = context.open(path)

  try {
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    return {
      schema: database.prepare('SELECT type, name, tbl_name, rootpage, sql FROM sqlite_schema ORDER BY type, name').all(),
      rows: Object.fromEntries([...expectedTables, 'sqlite_sequence'].map(table => [
        table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
      ]))
    }
  } finally {
    closeDatabase(database)
  }
}

function fingerprintFile(path) {
  // Compare only after every SQLite connection has closed, with no sidecars.
  for (const suffix of ['-journal', '-wal', '-shm']) {
    assert.equal(existsSync(path + suffix), false)
  }

  const stat = lstatSync(path, { bigint: true })
  return {
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    dev: stat.dev,
    ino: stat.ino
  }
}

function populateDatabase(context, path) {
  const database = context.open(path)

  try {
    insertMinimalFixture(database)
  } finally {
    closeDatabase(database)
  }
}

test('repeated function initialization preserves all existing data, schema and file bytes', { timeout: 10000 }, t => {
  const context = createDatabaseContext(t)
  const path = context.path('populated.db')
  context.initialize(path)
  populateDatabase(context, path)
  const contents = snapshotContents(context, path)
  const fingerprint = fingerprintFile(path)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => context.initialize(path), { code: 'EEXIST' })
    assert.deepEqual(fingerprintFile(path), fingerprint)
    assert.deepEqual(snapshotContents(context, path), contents)
  }
})

test('a second CLI initialization refuses the populated database without modifying it', { timeout: 45000 }, t => {
  const context = createDatabaseContext(t)
  const path = context.path('populated-cli.db')
  const first = runInitializationCli(context, path)
  assert.equal(first.status, 0, first.stderr)
  assert.equal(first.stdout.trim(), 'Database initialized successfully.')
  populateDatabase(context, path)
  const contents = snapshotContents(context, path)
  const fingerprint = fingerprintFile(path)

  const second = runInitializationCli(context, path)
  assert.equal(second.status, 1, second.stderr)
  assert.equal(second.stdout.trim(), '')
  assert.match(second.stderr, /Database initialization refused:/)
  assert.doesNotMatch(second.stderr, /Database initialization failed:/)
  assert.deepEqual(fingerprintFile(path), fingerprint)
  assert.deepEqual(snapshotContents(context, path), contents)
})

test('existing zero-byte files stay untouched through both initialization entry points', { timeout: 30000 }, t => {
  const context = createDatabaseContext(t)
  const path = context.path('empty.db')
  writeFileSync(path, '')
  const fingerprint = fingerprintFile(path)
  assert.equal(fingerprint.size, 0n)

  assert.throws(() => context.initialize(path), { code: 'EEXIST' })
  assert.deepEqual(fingerprintFile(path), fingerprint)
  const result = runInitializationCli(context, path)
  assert.equal(result.status, 1, result.stderr)
  assert.equal(result.stdout.trim(), '')
  assert.match(result.stderr, /Database initialization refused:/)
  assert.deepEqual(fingerprintFile(path), fingerprint)
})
