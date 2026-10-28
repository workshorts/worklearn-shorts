import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { closeDatabase } from '../../src/db/connection.js'
import { prepareSeedAdmin } from '../../src/db/seed-admin.js'
import { withTransaction } from '../../src/db/transaction.js'
import { verifyPassword } from '../../src/lib/password.js'
import { createDatabaseContext } from '../helpers/database-context.js'

const environment = { ADMIN_USERNAME: 'Seed Admin', ADMIN_PASSWORD: ' Test-only Password ' }

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('prepared-admin.db')
  context.initialize(path)
  return { context, path, database: context.open(path) }
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

test('seed administrator preparation returns a verifiable hash without retaining the password or inserting rows', t => {
  const { database } = setup(t)
  const input = Object.freeze({ ...environment })
  const before = snapshot(database)
  const prepared = prepareSeedAdmin(database, input)

  assert.deepEqual(Object.keys(prepared).sort(), ['passwordHash', 'username'])
  assert.equal(prepared.username, input.ADMIN_USERNAME)
  assert.match(prepared.passwordHash, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/)
  assert.equal(verifyPassword(input.ADMIN_PASSWORD, prepared.passwordHash), true)
  assert.equal(verifyPassword(input.ADMIN_PASSWORD.trim(), prepared.passwordHash), false)
  assert.equal(verifyPassword('wrong-password', prepared.passwordHash), false)
  assert.equal(JSON.stringify(prepared).includes(input.ADMIN_PASSWORD), false)
  assert.deepEqual(snapshot(database), before)
  assert.equal(database.isTransaction, false)
  assert.equal(database.isOpen, true)
})

test('repeated preparation uses a new salt each time and does not create a pending administrator', t => {
  const { database } = setup(t)
  const before = snapshot(database)
  const first = prepareSeedAdmin(database, environment)
  const second = prepareSeedAdmin(database, environment)

  assert.notEqual(first.passwordHash.split('$')[4], second.passwordHash.split('$')[4])
  assert.equal(verifyPassword(environment.ADMIN_PASSWORD, first.passwordHash), true)
  assert.equal(verifyPassword(environment.ADMIN_PASSWORD, second.passwordHash), true)
  assert.deepEqual(snapshot(database), before)
})

test('seed administrator preparation skips an existing account without returning or repairing its stored hash', t => {
  const { database } = setup(t)
  database.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(environment.ADMIN_USERNAME, 'existing-hash-not-to-be-repaired', '2025-01-02T03:04:05.000Z')
  const before = snapshot(database)

  assert.equal(prepareSeedAdmin(database, environment), null)
  assert.equal(prepareSeedAdmin(database, { ...environment, ADMIN_PASSWORD: 'different-test-password' }), null)
  assert.deepEqual(snapshot(database), before)
})

test('seed administrator preparation uses exact usernames even when another administrator exists', t => {
  const { database } = setup(t)
  database.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
    .run(environment.ADMIN_USERNAME, 'test-only-placeholder')
  const before = snapshot(database)
  for (const username of ['seed admin', ' Seed Admin', 'Seed Admin ']) {
    const prepared = prepareSeedAdmin(database, { ...environment, ADMIN_USERNAME: username })
    assert.equal(prepared.username, username)
    assert.equal(verifyPassword(environment.ADMIN_PASSWORD, prepared.passwordHash), true)
  }
  assert.deepEqual(snapshot(database), before)
})

test('seed administrator preparation rejects invalid configuration even for an existing account', t => {
  const { database } = setup(t)
  database.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
    .run(environment.ADMIN_USERNAME, 'test-only-placeholder')
  const before = snapshot(database)
  for (const input of [{}, { ...environment, ADMIN_PASSWORD: 'short' }, { ...environment, ADMIN_USERNAME: '' }]) {
    assert.throws(() => prepareSeedAdmin(database, input), { code: 'INVALID_SEED_ADMIN_CONFIG' })
  }
  assert.deepEqual(snapshot(database), before)
})

test('seed administrator preparation refuses an active transaction without ending the caller transaction', t => {
  const { database } = setup(t)
  const before = snapshot(database)
  withTransaction(database, connection => {
    assert.throws(() => prepareSeedAdmin(connection, environment), {
      message: 'Seed administrator hashing must run before a transaction starts.'
    })
    assert.equal(connection.isTransaction, true)
    assert.equal(connection.isOpen, true)
  })
  assert.deepEqual(snapshot(database), before)
})

test('seed administrator preparation supports a query-only connection and preserves the database file', t => {
  const { context, path, database } = setup(t)
  closeDatabase(database)
  const before = fingerprint(path)
  const reader = context.open(path)
  reader.exec('PRAGMA query_only = ON')
  const prepared = prepareSeedAdmin(reader, environment)
  assert.equal(verifyPassword(environment.ADMIN_PASSWORD, prepared.passwordHash), true)
  closeDatabase(reader)
  assert.deepEqual(fingerprint(path), before)
})

test('seed administrator preparation refuses a closed connection without reopening or changing it', t => {
  const { path, database } = setup(t)
  closeDatabase(database)
  const before = fingerprint(path)
  assert.throws(() => prepareSeedAdmin(database, environment), { message: 'Database connection is closed.' })
  assert.equal(database.isOpen, false)
  assert.deepEqual(fingerprint(path), before)
})
