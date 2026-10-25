import assert from 'node:assert/strict'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
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

test('first CLI initialization succeeds from another cwd and persists the complete schema', { timeout: 30000 }, t => {
  const context = createDatabaseContext(t)
  const path = context.path('새 DB # %', 'app.db')
  const entry = fileURLToPath(new URL('../../db/init.js', import.meta.url))
  const environment = { ...process.env, DB_PATH: path }
  delete environment.NODE_TEST_CONTEXT
  assert.equal(existsSync(path), false)

  const result = spawnSync(process.execPath, [entry], {
    cwd: context.directory,
    env: environment,
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true
  })

  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'Database initialized successfully.')
  assert.doesNotMatch(result.stderr, /Database initialization (?:failed|refused):/)
  assertFreshDatabase(context, path)
})
