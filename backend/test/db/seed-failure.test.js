import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { closeDatabase } from '../../src/db/connection.js'
import { SEED_VIDEOS } from '../../src/db/seed-videos.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'
import { createSeedMediaFixture } from '../helpers/seed-media-fixture.js'

const entry = fileURLToPath(new URL('../../db/seed.js', import.meta.url))
const preload = new URL('../helpers/seed-storage-failure-worker.js', import.meta.url).href
const username = 'failure-matrix-admin'
const password = 'failure-matrix-password'
const tables = ['admins', 'tags', 'videos', 'video_tags', 'courses', 'course_videos',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('seed-failure.db')
  context.initialize(path)
  const database = context.open(path)
  insertMinimalFixture(database)
  closeDatabase(database)
  return { context, path, uploadDir: createSeedMediaFixture(context), trace: context.path('seed-failure-trace.json') }
}

function run(state, mode = 'observe', overrides = {}) {
  const environment = { ...process.env, NODE_NO_WARNINGS: '1', DB_PATH: state.path, UPLOAD_DIR: state.uploadDir,
    ADMIN_USERNAME: username, ADMIN_PASSWORD: password,
    TEST_SEED_STORAGE_FAILURE: mode, TEST_SEED_STORAGE_TRACE: state.trace, ...overrides }
  delete environment.NODE_TEST_CONTEXT
  delete environment.NODE_OPTIONS
  const result = spawnSync(process.execPath, ['--import', preload, entry], {
    cwd: state.context.directory, env: environment, encoding: 'utf8', timeout: 25000, windowsHide: true
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.signal, null, result.stderr)
  for (const value of [username, password, state.path, state.uploadDir, 'scrypt$', 'file://', 'Error:']) {
    assert.equal((result.stdout + result.stderr).includes(value), false, value)
  }
  return { ...result, trace: JSON.parse(readFileSync(state.trace, 'utf8')) }
}

function snapshot(state) {
  const database = state.context.open(state.path)
  try {
    return {
      schema: database.prepare('SELECT type, name, tbl_name, rootpage, sql FROM sqlite_schema ORDER BY type, name').all(),
      rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
    }
  } finally {
    closeDatabase(database)
  }
}

function hash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function media(state) {
  return SEED_VIDEOS.flatMap(({ videoPath, thumbnailPath }) => [videoPath, thumbnailPath].filter(path => path !== null))
    .map(path => [path, existsSync(join(state.uploadDir, path)) ? hash(join(state.uploadDir, path)) : null])
}

function assertFailure(state, result, before, beforeMedia, began) {
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Database seeding (?:failed|refused)/)
  assert.equal(result.trace.writeBegins, began)
  assert.equal(result.trace.writeCommits, 0)
  assert.equal(result.trace.writeRollbacks, began)
  assert.equal(result.trace.closeCalls, 1)
  assert.equal(result.trace.closed, true)
  assert.equal(result.trace.transactionBeforeClose, false)
  assert.deepEqual(snapshot(state), before)
  assert.deepEqual(media(state), beforeMedia)
  for (const suffix of ['-journal', '-wal', '-shm']) assert.equal(existsSync(state.path + suffix), false)
}

function assertRecovery(state) {
  const result = run(state)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.trace.writeCommits, 1)
  const after = snapshot(state).rows
  assert.equal(after.admins.length, 2)
  assert.equal(after.tags.length, 8)
  assert.equal(after.videos.length, 9)
  assert.equal(after.video_tags.length, 11)
}

for (const kind of ['missing username', 'short password', 'missing video', 'invalid thumbnail']) {
  test(`seed CLI rejects ${kind} before writes and succeeds after correcting the input`, { timeout: 30000 }, t => {
    const state = setup(t)
    const overrides = {}
    let restore = () => {}
    if (kind === 'missing username') overrides.ADMIN_USERNAME = ''
    if (kind === 'short password') overrides.ADMIN_PASSWORD = 'short'
    if (kind === 'missing video' || kind === 'invalid thumbnail') {
      const path = join(state.uploadDir, kind === 'missing video' ? SEED_VIDEOS[7].videoPath : SEED_VIDEOS[6].thumbnailPath)
      const bytes = readFileSync(path)
      restore = () => writeFileSync(path, bytes)
      if (kind === 'missing video') unlinkSync(path)
      else writeFileSync(path, 'Invalid WebP signature for the seed failure test')
    }
    const before = snapshot(state)
    const beforeMedia = media(state)
    const beforeHash = hash(state.path)
    const result = run(state, 'observe', overrides)
    assertFailure(state, result, before, beforeMedia, 0)
    assert.match(result.stderr, kind.includes('username') || kind.includes('password') ? /configure ADMIN_USERNAME/ : /sample media is missing or invalid/)
    assert.equal(hash(state.path), beforeHash)
    restore()
    assertRecovery(state)
  })
}

test('seed CLI preserves an existing orphaned reference and rejects the DB without trying to repair it', { timeout: 30000 }, t => {
  const state = setup(t)
  const database = state.context.open(state.path)
  database.exec('PRAGMA foreign_keys = OFF')
  database.prepare('INSERT INTO video_likes (video_id, visitor_id) VALUES (?, ?)').run(-1, 'test-only-orphan')
  closeDatabase(database)
  const before = snapshot(state)
  const beforeMedia = media(state)
  const beforeHash = hash(state.path)
  const result = run(state)
  assertFailure(state, result, before, beforeMedia, 0)
  assert.match(result.stderr, /existing database schema is incompatible/)
  assert.equal(hash(state.path), beforeHash)
  const repaired = state.context.open(state.path)
  repaired.prepare('DELETE FROM video_likes WHERE video_id = ?').run(-1)
  closeDatabase(repaired)
  assertRecovery(state)
})

test('seed CLI rolls back newly inserted administrators and tags when a later sample path is ambiguous', { timeout: 30000 }, t => {
  const state = setup(t)
  const database = state.context.open(state.path)
  const insert = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
  insert.run('Existing path owner one', SEED_VIDEOS[7].videoPath)
  insert.run('Existing path owner two', SEED_VIDEOS[7].videoPath)
  closeDatabase(database)
  const before = snapshot(state)
  const beforeMedia = media(state)
  const result = run(state)
  assertFailure(state, result, before, beforeMedia, 1)
  assert.match(result.stderr, /multiple existing videos match/)
})

for (const { mode, counts, code } of [
  { mode: 'tags', counts: [2, 3, 1, 1], code: 2067 },
  { mode: 'videos', counts: [2, 8, 4, 1], code: 8 },
  { mode: 'links', counts: [2, 8, 9, 6], code: 787 }
]) {
  test(`seed CLI rolls back every group after a native SQLite failure in ${mode}`, { timeout: 30000 }, t => {
    const state = setup(t)
    const before = snapshot(state)
    const beforeMedia = media(state)
    const result = run(state, mode)
    assertFailure(state, result, before, beforeMedia, 1)
    assert.deepEqual(result.trace.failureCounts, counts)
    assert.equal(result.trace.errorCode, 'ERR_SQLITE_ERROR')
    assert.equal(result.trace.sqliteCode, code)
    assertRecovery(state)
  })
}

test('seed CLI rolls back a real busy COMMIT caused by another reader and succeeds after the reader releases its lock', { timeout: 45000 }, t => {
  const state = setup(t)
  const before = snapshot(state)
  const beforeMedia = media(state)
  const reader = state.context.open(state.path)
  reader.exec('BEGIN')
  reader.prepare('SELECT count(*) AS count FROM admins').get()
  let result
  try {
    result = run(state)
  } finally {
    reader.exec('ROLLBACK')
    closeDatabase(reader)
  }
  assertFailure(state, result, before, beforeMedia, 1)
  assert.deepEqual(result.trace.failureCounts, [2, 8, 9, 11])
  assert.equal(result.trace.errorCode, 'ERR_SQLITE_ERROR')
  assert.equal(result.trace.sqliteCode, 5)
  assertRecovery(state)
})
