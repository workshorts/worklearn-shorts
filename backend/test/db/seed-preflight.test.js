import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { closeDatabase } from '../../src/db/connection.js'
import { openSeedDatabase, verifySeedDatabase } from '../../src/db/seed-preflight.js'
import { withTransaction } from '../../src/db/transaction.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

function fingerprint(path) {
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

function snapshot(context, path) {
  const database = context.open(path)

  try {
    const schema = database.prepare(
      'SELECT type, name, tbl_name, rootpage, sql FROM sqlite_schema ORDER BY type, name'
    ).all()
    const tables = schema.filter(row => row.type === 'table')
    const rows = Object.fromEntries(tables.map(table => [
      table.name,
      database.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}" ORDER BY rowid`).all()
    ]))
    return { schema, rows }
  } finally {
    closeDatabase(database)
  }
}

function populatedDatabase(t, mutate = () => {}) {
  const context = createDatabaseContext(t)
  const path = context.path('preflight.db')
  context.initialize(path)
  const database = context.open(path)

  try {
    insertMinimalFixture(database)
    mutate(database)
  } finally {
    closeDatabase(database)
  }

  return { context, path }
}

function assertRejectedAndPreserved(context, path, code) {
  const before = snapshot(context, path)
  const file = fingerprint(path)
  assert.throws(() => openSeedDatabase(path), { code })
  assert.deepEqual(fingerprint(path), file)
  assert.deepEqual(snapshot(context, path), before)
  assert.deepEqual(fingerprint(path), file)

  // Windows must be able to move the file after the rejected connection closes.
  const moved = context.path('closed-preflight.db')
  renameSync(path, moved)
  renameSync(moved, path)
}

test('seed preflight refuses a missing DB without creating its file or parent directories', { timeout: 10000 }, t => {
  const context = createDatabaseContext(t)
  const paths = [context.path('missing.db'), context.path('missing', 'nested', 'app.db')]

  for (const path of paths) {
    assert.throws(() => openSeedDatabase(path))
    assert.equal(existsSync(path), false)
    assert.deepEqual(readdirSync(context.directory), [])
  }
})

test('seed preflight uses configured DB_PATH without creating a missing configured database', { timeout: 10000 }, t => {
  const context = createDatabaseContext(t)
  const previous = process.env.DB_PATH
  t.after(() => {
    if (previous === undefined) delete process.env.DB_PATH
    else process.env.DB_PATH = previous
  })
  process.env.DB_PATH = context.path('configured.db')

  assert.throws(() => openSeedDatabase())
  assert.equal(existsSync(process.env.DB_PATH), false)
  assert.deepEqual(readdirSync(context.directory), [])
})

test('seed preflight accepts an initialized empty database without inserting seed data', { timeout: 10000 }, t => {
  const context = createDatabaseContext(t)
  const path = context.path('empty-initialized.db')
  context.initialize(path)
  const file = fingerprint(path)
  const database = openSeedDatabase(path)
  context.addCleanup(() => closeDatabase(database))

  try {
    const tables = database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*'"
    ).all()
    assert.equal(tables.length, 11)
    for (const { name } of tables) {
      assert.equal(database.prepare(`SELECT count(*) AS count FROM "${name}"`).get().count, 0)
    }
    assert.equal(database.isTransaction, false)
  } finally {
    closeDatabase(database)
  }

  assert.deepEqual(fingerprint(path), file)
})

test('successful seed preflight preserves every row and sequence and returns a usable owned connection', { timeout: 10000 }, t => {
  const { context, path } = populatedDatabase(t)
  const before = snapshot(context, path)
  const file = fingerprint(path)
  const database = openSeedDatabase(path)
  context.addCleanup(() => closeDatabase(database))

  try {
    assert.equal(database.isOpen, true)
    assert.equal(database.isTransaction, false)
    assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
    assert.equal(database.prepare('PRAGMA busy_timeout').get().timeout, 5000)
    assert.deepEqual(verifySeedDatabase(database), { tableCount: 11, columnCount: 45 })
  } finally {
    closeDatabase(database)
  }

  assert.deepEqual(fingerprint(path), file)
  assert.deepEqual(snapshot(context, path), before)
  assert.deepEqual(fingerprint(path), file)
})

test('seed preflight rejects a legacy database without migrating or replacing its data', { timeout: 10000 }, t => {
  const context = createDatabaseContext(t)
  const path = context.path('legacy.db')
  const database = new DatabaseSync(path)

  try {
    database.exec("CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO categories VALUES (7, 'Existing category')")
  } finally {
    database.close()
  }

  assertRejectedAndPreserved(context, path, 'INVALID_DATABASE_SCHEMA')
})

const incompatibleSchemas = [
  ['a missing required table', 'DROP TABLE comments'],
  ['an extra column', 'ALTER TABLE videos ADD COLUMN unexpected TEXT'],
  ['a missing tag uniqueness index', 'DROP INDEX idx_tags_name_normalized'],
  ['an incorrect tag uniqueness expression', 'DROP INDEX idx_tags_name_normalized; CREATE UNIQUE INDEX idx_tags_name_normalized ON tags (lower(name))'],
  ['an unexpected view', 'CREATE VIEW unexpected AS SELECT id FROM videos'],
  ['an orphaned foreign key', 'PRAGMA foreign_keys = OFF; INSERT INTO video_tags (video_id, tag_id) VALUES (999, 999)']
]

for (const [name, sql] of incompatibleSchemas) {
  test(`seed preflight rejects ${name} while preserving existing data and file bytes`, { timeout: 10000 }, t => {
    const { context, path } = populatedDatabase(t, database => database.exec(sql))
    assertRejectedAndPreserved(context, path, 'INVALID_DATABASE_SCHEMA')
  })
}

test('seed preflight rejects stored CHECK violations before writing or repairing the database', { timeout: 10000 }, t => {
  const { context, path } = populatedDatabase(t, database => {
    database.exec("PRAGMA ignore_check_constraints = ON; UPDATE videos SET title = ''; PRAGMA ignore_check_constraints = OFF")
  })

  assertRejectedAndPreserved(context, path, 'INVALID_DATABASE_INTEGRITY')
})

test('seed preflight leaves empty and non-SQLite existing files byte-for-byte unchanged', { timeout: 10000 }, t => {
  const context = createDatabaseContext(t)

  for (const [name, contents] of [['empty.db', ''], ['invalid.db', 'Existing non-SQLite contents']]) {
    const path = context.path(name)
    writeFileSync(path, contents)
    const file = fingerprint(path)
    assert.throws(() => openSeedDatabase(path))
    assert.deepEqual(fingerprint(path), file)
    const moved = context.path(name + '.closed')
    renameSync(path, moved)
    renameSync(moved, path)
  }
})

test('seed verification rechecks the caller transaction without committing or closing it', { timeout: 10000 }, t => {
  const { context, path } = populatedDatabase(t)
  const database = context.open(path)

  withTransaction(database, connection => {
    assert.deepEqual(verifySeedDatabase(connection), { tableCount: 11, columnCount: 45 })
    assert.equal(connection.isOpen, true)
    assert.equal(connection.isTransaction, true)
  })

  database.exec('DROP INDEX idx_quiz_options_one_correct')
  withTransaction(database, connection => {
    assert.throws(() => verifySeedDatabase(connection), { code: 'INVALID_DATABASE_SCHEMA' })
    assert.equal(connection.isOpen, true)
    assert.equal(connection.isTransaction, true)
  })

  assert.equal(database.isTransaction, false)
})
