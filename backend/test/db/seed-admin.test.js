import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { closeDatabase } from '../../src/db/connection.js'
import { hasSeedAdmin } from '../../src/db/seed-admin.js'
import { withTransaction } from '../../src/db/transaction.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

function setup(t, { populated = true } = {}) {
  const context = createDatabaseContext(t)
  const path = context.path('seed-admin.db')
  context.initialize(path)
  const database = context.open(path)
  if (populated) insertMinimalFixture(database)
  return { context, path, database }
}

function snapshot(database) {
  return {
    rows: database.prepare('SELECT * FROM admins ORDER BY id').all(),
    sequence: database.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()
  }
}

function fingerprint(path) {
  const stat = lstatSync(path, { bigint: true })
  return {
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
    size: stat.size, mtimeNs: stat.mtimeNs, dev: stat.dev, ino: stat.ino
  }
}

test('seed administrator lookup returns false in an empty DB without inserting an account or sequence', t => {
  const { database } = setup(t, { populated: false })
  const before = snapshot(database)
  assert.equal(hasSeedAdmin(database, 'new-admin'), false)
  assert.equal(hasSeedAdmin(database, 'new-admin'), false)
  assert.deepEqual(snapshot(database), before)
  assert.equal(database.isOpen, true)
  assert.equal(database.isTransaction, false)
})

test('seed administrator lookup returns only a boolean and preserves existing hashes and timestamps', t => {
  const { database } = setup(t)
  database.prepare('UPDATE admins SET password_hash = ?, created_at = ? WHERE username = ?')
    .run('existing-hash-without-repair', '2025-01-02T03:04:05.000Z', 'fixture-admin')
  const before = snapshot(database)

  assert.equal(hasSeedAdmin(database, 'fixture-admin'), true)
  assert.equal(hasSeedAdmin(database, 'different-admin'), false)
  assert.equal(hasSeedAdmin(database, 'fixture-admin'), true)
  assert.deepEqual(snapshot(database), before)
})

test('seed administrator lookup distinguishes case, whitespace and Unicode forms without normalization', t => {
  const { database } = setup(t, { populated: false })
  const usernames = ['Admin', ' Admin', 'Admin ', '\u00e9-admin', 'e\u0301-admin']
  const insert = database.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
  for (const username of usernames) insert.run(username, 'test-only-placeholder')
  const before = snapshot(database)

  for (const username of usernames) assert.equal(hasSeedAdmin(database, username), true)
  for (const username of ['admin', 'ADMIN', ' Admin ', '\u00c9-admin']) {
    assert.equal(hasSeedAdmin(database, username), false)
  }
  assert.deepEqual(snapshot(database), before)
})

test('seed administrator lookup binds SQL-like usernames as literal values', t => {
  const { database } = setup(t)
  const username = "' OR 1=1 --"
  const before = snapshot(database)
  assert.equal(hasSeedAdmin(database, username), false)
  assert.deepEqual(snapshot(database), before)

  database.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
    .run(username, 'test-only-placeholder')
  const after = snapshot(database)
  assert.equal(hasSeedAdmin(database, username), true)
  assert.equal(hasSeedAdmin(database, "'; DROP TABLE admins; --"), false)
  assert.deepEqual(snapshot(database), after)
})

test('seed administrator lookup works on a query-only connection and preserves the entire DB file', t => {
  const { context, path, database } = setup(t)
  closeDatabase(database)
  const before = fingerprint(path)
  const reader = context.open(path)
  reader.exec('PRAGMA query_only = ON')

  assert.equal(hasSeedAdmin(reader, 'fixture-admin'), true)
  assert.equal(hasSeedAdmin(reader, 'new-admin'), false)
  closeDatabase(reader)
  assert.deepEqual(fingerprint(path), before)
})

test('seed administrator lookup leaves the caller transaction open and observes its commit or rollback', t => {
  const { context, path, database } = setup(t)
  const observer = context.open(path)
  const before = snapshot(database)
  const failure = new Error('Expected transaction rollback')

  assert.throws(() => withTransaction(database, connection => {
    connection.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
      .run('pending-admin', 'test-only-placeholder')
    assert.equal(hasSeedAdmin(connection, 'pending-admin'), true)
    assert.equal(hasSeedAdmin(observer, 'pending-admin'), false)
    assert.equal(connection.isTransaction, true)
    assert.equal(connection.isOpen, true)
    throw failure
  }), error => error === failure)

  assert.equal(hasSeedAdmin(database, 'pending-admin'), false)
  assert.equal(hasSeedAdmin(observer, 'pending-admin'), false)
  assert.deepEqual(snapshot(database), before)

  withTransaction(database, connection => {
    assert.equal(hasSeedAdmin(connection, 'pending-admin'), false)
    connection.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
      .run('pending-admin', 'test-only-placeholder')
    assert.equal(hasSeedAdmin(connection, 'pending-admin'), true)
    assert.equal(connection.isTransaction, true)
  })
  assert.equal(hasSeedAdmin(observer, 'pending-admin'), true)
  assert.equal(database.isTransaction, false)
})

test('seed administrator lookup does not cache results across other connections or reopening', t => {
  const { context, path, database } = setup(t)
  const other = context.open(path)
  assert.equal(hasSeedAdmin(database, 'later-admin'), false)
  other.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
    .run('later-admin', 'test-only-placeholder')
  assert.equal(hasSeedAdmin(database, 'later-admin'), true)
  closeDatabase(database)
  const reopened = context.open(path)
  assert.equal(hasSeedAdmin(reopened, 'later-admin'), true)
  other.prepare('DELETE FROM admins WHERE username = ?').run('later-admin')
  assert.equal(hasSeedAdmin(reopened, 'later-admin'), false)
})

test('seed administrator lookup rejects invalid usernames without coercion or account changes', t => {
  const { database } = setup(t)
  const before = snapshot(database)
  for (const username of [undefined, null, 7, {}, [], new String('admin'), '', 'u'.repeat(51), 'admin\0value']) {
    assert.throws(() => hasSeedAdmin(database, username), {
      name: 'TypeError',
      message: 'Seed administrator lookup requires a username of 1 to 50 characters without null characters.'
    })
  }
  assert.deepEqual(snapshot(database), before)
  assert.equal(database.isOpen, true)
})

test('seed administrator lookup refuses a closed connection without reopening or modifying its file', t => {
  const { path, database } = setup(t)
  closeDatabase(database)
  const before = fingerprint(path)
  assert.throws(() => hasSeedAdmin(database, 'fixture-admin'), { message: 'Database connection is closed.' })
  assert.equal(database.isOpen, false)
  assert.deepEqual(fingerprint(path), before)
})
