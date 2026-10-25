import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('admin-username.db')
  context.initialize(path)
  const database = context.open(path)
  const { adminId } = insertMinimalFixture(database)
  return { context, path, database, adminId }
}

function snapshotAdmins(database) {
  return {
    rows: database.prepare('SELECT * FROM admins ORDER BY id').all(),
    sequence: database.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get('admins')
  }
}

function isUniqueFailure(error) {
  // Require a UNIQUE violation, not an unrelated CHECK or primary-key failure.
  assert.equal(error.code, 'ERR_SQLITE_ERROR')
  assert.equal(error.errcode, 2067)
  return true
}

test('duplicate admin usernames are rejected after reopening without replacing the existing account', { timeout: 10000 }, t => {
  const { context, path, database, adminId } = setup(t)
  const original = database.prepare('SELECT * FROM admins WHERE id = ?').get(adminId)
  database.close()
  const reopened = context.open(path)
  const insert = reopened.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
  const before = snapshotAdmins(reopened)

  // A different hash must not turn the same username into a distinct account.
  assert.throws(() => insert.run(original.username, 'different-test-only-placeholder'), isUniqueFailure)
  assert.deepEqual(snapshotAdmins(reopened), before)
  assert.equal(reopened.isTransaction, false)
  assert.deepEqual(reopened.prepare('SELECT * FROM admins WHERE id = ?').get(adminId), original)

  // Reusing a hash with a different username remains valid.
  const result = insert.run('another-admin', original.password_hash)
  assert.equal(result.changes, 1)
  assert.notEqual(result.lastInsertRowid, adminId)
  assert.equal(reopened.prepare('SELECT count(*) AS count FROM admins').get().count, 2)
  assert.deepEqual(reopened.prepare('SELECT * FROM admins WHERE id = ?').get(adminId), original)
})

test('conflicting admin username updates preserve both accounts and allow a valid rename', { timeout: 10000 }, t => {
  const { context, path, database, adminId } = setup(t)
  const original = database.prepare('SELECT * FROM admins WHERE id = ?').get(adminId)
  const insert = database.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
  const secondId = insert.run('second-admin', 'second-test-only-placeholder').lastInsertRowid
  const second = database.prepare('SELECT * FROM admins WHERE id = ?').get(secondId)
  const update = database.prepare('UPDATE admins SET username = ?, password_hash = ? WHERE id = ?')
  const before = snapshotAdmins(database)
  const nextHash = 'updated-test-only-placeholder'

  assert.throws(() => update.run(original.username, nextHash, secondId), isUniqueFailure)
  assert.deepEqual(snapshotAdmins(database), before)
  assert.equal(database.isTransaction, false)

  assert.equal(database.prepare('UPDATE admins SET username = ? WHERE id = ?')
    .run(original.username, adminId).changes, 1)
  assert.deepEqual(snapshotAdmins(database), before)

  // Change only the conflicting username in the rejected UPDATE.
  assert.equal(update.run('renamed-admin', nextHash, secondId).changes, 1)
  assert.deepEqual({ ...database.prepare('SELECT * FROM admins WHERE id = ?').get(secondId) },
    { ...second, username: 'renamed-admin', password_hash: nextHash })
  assert.equal(insert.run(second.username, original.password_hash).changes, 1)
  const after = snapshotAdmins(database)
  assert.equal(after.rows.length, 3)
  assert.deepEqual(database.prepare('SELECT * FROM admins WHERE id = ?').get(adminId), original)
  database.close()
  assert.deepEqual(snapshotAdmins(context.open(path)), after)
})

test('admin username uniqueness uses the exact stored name without tag normalization', { timeout: 10000 }, t => {
  const { database, adminId } = setup(t)
  const original = database.prepare('SELECT * FROM admins WHERE id = ?').get(adminId)
  const variants = ['Fixture-admin', ' fixture-admin', 'fixture-admin ']
  const insert = database.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')

  for (const username of variants) {
    const result = insert.run(username, original.password_hash)
    assert.equal(result.changes, 1)
    assert.equal(database.prepare('SELECT username FROM admins WHERE id = ?')
      .get(result.lastInsertRowid).username, username)
    const before = snapshotAdmins(database)
    assert.throws(() => insert.run(username, 'different-test-only-placeholder'), isUniqueFailure)
    assert.deepEqual(snapshotAdmins(database), before)
    assert.equal(database.isTransaction, false)
  }

  assert.deepEqual(database.prepare('SELECT username FROM admins ORDER BY id').all()
    .map(row => row.username), [original.username, ...variants])
  assert.deepEqual(database.prepare('SELECT * FROM admins WHERE id = ?').get(adminId), original)
})
