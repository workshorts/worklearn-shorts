import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { closeDatabase } from '../../src/db/connection.js'
import { insertSeedAdmin, prepareSeedAdmin } from '../../src/db/seed-admin.js'
import { withTransaction } from '../../src/db/transaction.js'
import { hashPassword, verifyPassword } from '../../src/lib/password.js'
import { createDatabaseContext } from '../helpers/database-context.js'

const environment = { ADMIN_USERNAME: 'seed-admin', ADMIN_PASSWORD: 'test-only-password' }

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('insert-admin.db')
  context.initialize(path)
  return { context, path, database: context.open(path) }
}

function snapshot(database) {
  return {
    admins: database.prepare('SELECT * FROM admins ORDER BY id').all(),
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

test('seed administrator insertion stores only the prepared hash and uses the default creation timestamp', t => {
  const { context, path, database } = setup(t)
  const prepared = prepareSeedAdmin(database, environment)
  const started = Date.now()
  const created = withTransaction(database, connection => {
    const result = insertSeedAdmin(connection, prepared)
    assert.equal(connection.isTransaction, true)
    return result
  })
  assert.equal(created, true)
  const rows = database.prepare('SELECT * FROM admins').all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].username, prepared.username)
  assert.equal(rows[0].password_hash, prepared.passwordHash)
  assert.notEqual(rows[0].password_hash, environment.ADMIN_PASSWORD)
  assert.equal(verifyPassword(environment.ADMIN_PASSWORD, rows[0].password_hash), true)
  assert.match(rows[0].created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.ok(Date.parse(rows[0].created_at) >= started)
  assert.ok(Date.parse(rows[0].created_at) <= Date.now())
  const before = snapshot(database)
  closeDatabase(database)
  assert.deepEqual(snapshot(context.open(path)), before)
})

test('seed administrator insertion treats a skipped preparation as a no-op without allocating an ID', t => {
  const { database } = setup(t)
  const before = snapshot(database)
  assert.equal(withTransaction(database, connection => insertSeedAdmin(connection, null)), false)
  assert.deepEqual(snapshot(database), before)
})

test('repeated seed administrator insertion preserves the original hash, creation time, sequence and file', t => {
  const { context, path, database } = setup(t)
  const prepared = prepareSeedAdmin(database, environment)
  withTransaction(database, connection => insertSeedAdmin(connection, prepared))
  const alternative = { ...prepared, passwordHash: hashPassword('different-test-password') }
  const before = snapshot(database)
  closeDatabase(database)
  const file = fingerprint(path)
  const reopened = context.open(path)
  for (const candidate of [prepared, alternative]) {
    assert.equal(withTransaction(reopened, connection => insertSeedAdmin(connection, candidate)), false)
    assert.deepEqual(snapshot(reopened), before)
  }
  closeDatabase(reopened)
  assert.deepEqual(fingerprint(path), file)
})

test('insertion rechecks accounts created by another connection after preparation and preserves the winner', t => {
  const { context, path, database } = setup(t)
  const other = context.open(path)
  const first = prepareSeedAdmin(database, environment)
  const second = prepareSeedAdmin(other, { ...environment, ADMIN_PASSWORD: 'winner-test-password' })
  assert.equal(withTransaction(other, connection => insertSeedAdmin(connection, second)), true)
  const before = snapshot(other)
  assert.equal(withTransaction(database, connection => insertSeedAdmin(connection, first)), false)
  assert.deepEqual(snapshot(database), before)
  assert.equal(verifyPassword('winner-test-password', before.admins[0].password_hash), true)
  assert.equal(verifyPassword(environment.ADMIN_PASSWORD, before.admins[0].password_hash), false)
})

test('seed administrator insertion distinguishes exact usernames and binds SQL-like input literally', t => {
  const { database } = setup(t)
  const usernames = ['seed-admin', 'Seed-admin', ' seed-admin', "' OR 1=1 --"]
  const candidates = usernames.map(username => prepareSeedAdmin(database, { ...environment, ADMIN_USERNAME: username }))
  withTransaction(database, connection => {
    for (const candidate of candidates) assert.equal(insertSeedAdmin(connection, candidate), true)
  })
  assert.deepEqual(database.prepare('SELECT username FROM admins ORDER BY id').all().map(row => row.username), usernames)
  assert.equal(database.prepare('SELECT count(*) AS count FROM sqlite_sequence WHERE name = ?').get('admins').count, 1)
})

test('seed administrator insertion refuses writes outside a caller transaction or on a closed connection', t => {
  const { path, database } = setup(t)
  const prepared = prepareSeedAdmin(database, environment)
  const before = snapshot(database)
  assert.throws(() => insertSeedAdmin(database, prepared), { message: 'Seed administrator insertion requires an active transaction.' })
  assert.deepEqual(snapshot(database), before)
  closeDatabase(database)
  const file = fingerprint(path)
  assert.throws(() => insertSeedAdmin(database, prepared), { message: 'Database connection is closed.' })
  assert.equal(database.isOpen, false)
  assert.deepEqual(fingerprint(path), file)
})

test('seed administrator insertion rejects malformed candidates and plaintext before changing the database', t => {
  const { database } = setup(t)
  const prepared = prepareSeedAdmin(database, environment)
  const before = snapshot(database)
  const invalid = [
    undefined, 'plain-candidate', [], {},
    { ...prepared, username: '' }, { ...prepared, username: 'u'.repeat(51) }, { ...prepared, username: 'admin\0value' },
    { ...prepared, passwordHash: environment.ADMIN_PASSWORD }, { ...prepared, passwordHash: '' },
    { ...prepared, passwordHash: prepared.passwordHash + '$extra' },
    { ...prepared, passwordHash: prepared.passwordHash.toUpperCase() }
  ]
  withTransaction(database, connection => {
    for (const candidate of invalid) {
      assert.throws(() => insertSeedAdmin(connection, candidate), { name: 'TypeError' })
      assert.equal(connection.isTransaction, true)
      assert.deepEqual(snapshot(connection), before)
    }
  })
})

test('seed administrator insertion leaves rollback ownership to the caller and can recover after rollback', t => {
  const { database } = setup(t)
  const prepared = prepareSeedAdmin(database, environment)
  const before = snapshot(database)
  const failure = new Error('Expected seed insertion rollback')
  assert.throws(() => withTransaction(database, connection => {
    assert.equal(insertSeedAdmin(connection, prepared), true)
    assert.equal(connection.isTransaction, true)
    throw failure
  }), error => error === failure)
  assert.deepEqual(snapshot(database), before)
  assert.equal(database.isOpen, true)
  assert.equal(withTransaction(database, connection => insertSeedAdmin(connection, prepared)), true)
})

test('seed administrator insertion propagates storage failures without partial changes or closing the connection', t => {
  const { database } = setup(t)
  const prepared = prepareSeedAdmin(database, environment)
  const before = snapshot(database)
  assert.throws(() => withTransaction(database, connection => {
    connection.exec('PRAGMA query_only = ON')
    insertSeedAdmin(connection, prepared)
  }), { code: 'ERR_SQLITE_ERROR', errcode: 8 })
  assert.deepEqual(snapshot(database), before)
  assert.equal(database.isOpen, true)
  assert.equal(database.isTransaction, false)
  database.exec('PRAGMA query_only = OFF')
  assert.equal(withTransaction(database, connection => insertSeedAdmin(connection, prepared)), true)
})
