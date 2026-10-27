import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { closeDatabase } from '../../src/db/connection.js'
import { seedDatabase } from '../../src/db/seed.js'
import { SEED_VIDEOS } from '../../src/db/seed-videos.js'
import { hashPassword } from '../../src/lib/password.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'
import { createSeedMediaFixture } from '../helpers/seed-media-fixture.js'

const environment = { ADMIN_USERNAME: 'transaction-seed-admin', ADMIN_PASSWORD: 'test-only-seed-password' }
const tables = ['admins', 'tags', 'videos', 'video_tags', 'courses', 'course_videos',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('seed-transaction.db')
  context.initialize(path)
  return { context, path, database: context.open(path), uploadDir: createSeedMediaFixture(context) }
}

function snapshot(database) {
  return Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}

function seed(state, options = {}) {
  return seedDatabase(state.database, { environment, uploadDir: state.uploadDir, ...options })
}

function interceptInsert(t, database, table, occurrence, callback) {
  const prepare = database.prepare.bind(database)
  let count = 0
  return t.mock.method(database, 'prepare', sql => {
    const statement = prepare(sql)
    if (sql.startsWith(`INSERT INTO ${table} (`)) {
      const run = statement.run.bind(statement)
      t.mock.method(statement, 'run', (...args) => {
        count += 1
        if (count === occurrence) callback()
        return run(...args)
      })
    }
    return statement
  })
}

test('seed execution commits every group in one IMMEDIATE transaction and exposes only a safe summary', async t => {
  const state = setup(t)
  const { context, path, database } = state
  const exec = database.exec.bind(database)
  const commands = []
  t.mock.method(database, 'exec', sql => {
    commands.push(sql)
    return exec(sql)
  })
  const observer = context.open(path)
  interceptInsert(t, database, 'video_tags', 6, () => {
    assert.equal(database.isTransaction, true)
    assert.equal(database.prepare('SELECT count(*) AS count FROM video_tags').get().count, 5)
    for (const table of ['admins', 'tags', 'videos', 'video_tags']) {
      assert.equal(observer.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0)
    }
    observer.exec('PRAGMA busy_timeout = 0')
    assert.throws(() => observer.exec('BEGIN IMMEDIATE'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
  })
  const result = await seed(state)
  assert.deepEqual(result, { administratorCreated: true, tagCount: 7, videoCount: 8, videoTagCount: 10 })
  assert.deepEqual(commands, ['BEGIN', 'COMMIT', 'BEGIN IMMEDIATE', 'COMMIT'])
  assert.equal(JSON.stringify(result).includes(environment.ADMIN_PASSWORD), false)
  assert.equal(database.isOpen, true)
  assert.equal(database.isTransaction, false)
  const after = snapshot(database)
  assert.equal(after.admins.length, 1)
  assert.equal(after.tags.length, 7)
  assert.equal(after.videos.length, 8)
  assert.equal(after.video_tags.length, 10)
  assert.deepEqual(snapshot(observer), after)
  closeDatabase(database)
  closeDatabase(observer)
  assert.deepEqual(snapshot(context.open(path)), after)
})

for (const { table, occurrence, counts } of [
  { table: 'admins', occurrence: 1, counts: [1, 1, 1, 1] },
  { table: 'tags', occurrence: 3, counts: [2, 3, 1, 1] },
  { table: 'videos', occurrence: 4, counts: [2, 8, 4, 1] },
  { table: 'video_tags', occurrence: 6, counts: [2, 8, 9, 6] }
]) {
  test(`seed execution rolls back all groups and sequences after a failure in ${table}`, async t => {
    const state = setup(t)
    const { context, path, database } = state
    insertMinimalFixture(database)
    const observer = context.open(path)
    const before = snapshot(database)
    const failure = new Error(`Expected ${table} seed failure`)
    const mock = interceptInsert(t, database, table, occurrence, () => {
      assert.deepEqual(['admins', 'tags', 'videos', 'video_tags'].map(name =>
        database.prepare(`SELECT count(*) AS count FROM ${name}`).get().count), counts)
      assert.deepEqual(snapshot(observer), before)
      throw failure
    })
    await assert.rejects(seed(state), error => error === failure)
    assert.deepEqual(snapshot(database), before)
    assert.deepEqual(snapshot(observer), before)
    assert.equal(database.isOpen, true)
    assert.equal(database.isTransaction, false)
    mock.mock.restore()
    assert.equal((await seed(state)).administratorCreated, true)
  })
}

test('seed execution rolls back every group if the final COMMIT fails', async t => {
  const state = setup(t)
  const { database } = state
  insertMinimalFixture(database)
  const before = snapshot(database)
  const exec = database.exec.bind(database)
  const failure = new Error('Expected final seed COMMIT failure')
  let writeStarted = false
  const mock = t.mock.method(database, 'exec', sql => {
    if (sql === 'BEGIN IMMEDIATE') writeStarted = true
    if (sql === 'COMMIT' && writeStarted) {
      assert.equal(database.prepare('SELECT count(*) AS count FROM video_tags').get().count, 11)
      throw failure
    }
    return exec(sql)
  })
  await assert.rejects(seed(state), error => error === failure)
  assert.deepEqual(snapshot(database), before)
  assert.equal(database.isTransaction, false)
  mock.mock.restore()
  assert.equal((await seed(state)).videoTagCount, 10)
})

test('seed execution propagates native storage errors and rolls back already inserted groups', async t => {
  const state = setup(t)
  const { database } = state
  const before = snapshot(database)
  const mock = interceptInsert(t, database, 'video_tags', 3, () => database.exec('PRAGMA query_only = ON'))
  await assert.rejects(seed(state), { code: 'ERR_SQLITE_ERROR', errcode: 8 })
  assert.deepEqual(snapshot(database), before)
  assert.equal(database.isOpen, true)
  assert.equal(database.isTransaction, false)
  mock.mock.restore()
  database.exec('PRAGMA query_only = OFF')
  assert.equal((await seed(state)).videoTagCount, 10)
})

test('seed execution preserves existing accounts and unrelated records while adding missing baseline data', async t => {
  const state = setup(t)
  const { database } = state
  insertMinimalFixture(database)
  const before = snapshot(database)
  const result = await seed(state, { environment: { ADMIN_USERNAME: 'fixture-admin', ADMIN_PASSWORD: 'different-test-password' } })
  assert.equal(result.administratorCreated, false)
  const after = snapshot(database)
  assert.deepEqual(after.admins, before.admins)
  assert.deepEqual(after.videos[0], before.videos[0])
  assert.deepEqual(after.tags[0], before.tags[0])
  for (const table of ['courses', 'course_videos', 'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options']) {
    assert.deepEqual(after[table], before[table])
  }
})

test('seed execution rejects missing media before beginning a write transaction or changing the file', async t => {
  const state = setup(t)
  const { database, path } = state
  unlinkSync(join(state.uploadDir, SEED_VIDEOS[7].videoPath))
  const before = snapshot(database)
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
  const exec = database.exec.bind(database)
  const commands = []
  t.mock.method(database, 'exec', sql => { commands.push(sql); return exec(sql) })
  await assert.rejects(seed(state), { code: 'INVALID_SEED_MEDIA' })
  assert.deepEqual(commands, ['BEGIN', 'COMMIT'])
  assert.deepEqual(snapshot(database), before)
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), hash)
})

test('seed execution validates credentials before writes even for an existing account', async t => {
  const state = setup(t)
  insertMinimalFixture(state.database)
  const before = snapshot(state.database)
  await assert.rejects(seed(state, { environment: { ADMIN_USERNAME: 'fixture-admin', ADMIN_PASSWORD: '' } }), { code: 'INVALID_SEED_ADMIN_CONFIG' })
  assert.deepEqual(snapshot(state.database), before)
  assert.equal(state.database.isTransaction, false)
})

test('seed execution revalidates the schema after asynchronous media checks and before writes', async t => {
  const state = setup(t)
  const pending = seed(state)
  assert.equal(state.database.isTransaction, false)
  state.database.exec('CREATE TABLE unexpected_seed_race (id INTEGER PRIMARY KEY)')
  const before = snapshot(state.database)
  await assert.rejects(pending, { code: 'INVALID_DATABASE_SCHEMA' })
  assert.deepEqual(snapshot(state.database), before)
  assert.equal(state.database.isTransaction, false)
  assert.equal(state.database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'unexpected_seed_race'").get().count, 1)
})

test('seed execution preserves an administrator created by another connection during media preparation', async t => {
  const state = setup(t)
  const other = state.context.open(state.path)
  const winnerHash = hashPassword('other-connection-test-password')
  const pending = seed(state)
  other.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(environment.ADMIN_USERNAME, winnerHash)
  const original = other.prepare('SELECT * FROM admins').get()
  assert.equal((await pending).administratorCreated, false)
  assert.deepEqual(state.database.prepare('SELECT * FROM admins').get(), original)
})

test('seed execution refuses partial initialization if a skipped administrator disappears during preparation', async t => {
  const state = setup(t)
  insertMinimalFixture(state.database)
  const pending = seed(state, { environment: { ADMIN_USERNAME: 'fixture-admin', ADMIN_PASSWORD: 'test-only-password' } })
  state.database.prepare('DELETE FROM admins WHERE username = ?').run('fixture-admin')
  const before = snapshot(state.database)
  await assert.rejects(pending, { code: 'SEED_ADMIN_CHANGED' })
  assert.deepEqual(snapshot(state.database), before)
  assert.equal(state.database.isTransaction, false)
})

test('seed execution refuses closed or already transacting connections without taking ownership', async t => {
  const state = setup(t)
  state.database.exec('BEGIN IMMEDIATE')
  state.database.prepare('INSERT INTO tags (name) VALUES (?)').run('Caller owned tag')
  const before = snapshot(state.database)
  await assert.rejects(seed(state), { message: 'Seed execution requires a connection without an active transaction.' })
  assert.equal(state.database.isTransaction, true)
  assert.deepEqual(snapshot(state.database), before)
  state.database.exec('ROLLBACK')
  closeDatabase(state.database)
  await assert.rejects(seed(state), { message: 'Database connection is closed.' })
  assert.equal(state.database.isOpen, false)
})

test('seed execution leaves a caller transaction started during media preparation untouched', async t => {
  const state = setup(t)
  const pending = seed(state)
  state.database.exec('BEGIN IMMEDIATE')
  state.database.prepare('INSERT INTO tags (name) VALUES (?)').run('Caller owned during media')
  const before = snapshot(state.database)
  await assert.rejects(pending, { message: 'Nested transactions are not supported.' })
  assert.deepEqual(snapshot(state.database), before)
  assert.equal(state.database.isTransaction, true)
  state.database.exec('ROLLBACK')
})
