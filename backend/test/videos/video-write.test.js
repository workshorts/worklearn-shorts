import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { withVideoWriteTransaction } from '../../src/services/video-write.js'
import { createDatabaseContext } from '../helpers/database-context.js'

const visitorId = 'aabbccdd-eeff-4abc-8def-012345abcdef'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('video-write.db')
  context.initialize(path)
  return { context, path, database: context.open(path) }
}

function insertVideo(database, id) {
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
    .run(id, 'Write target ' + id, 'videos/10000000-0000-4000-8000-000000000001.mp4')
}

function assertMissing(operation) {
  assert.throws(operation, error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 404)
    assert.equal(error.code, 'NOT_FOUND')
    assert.equal(error.message, '영상을 찾을 수 없습니다.')
    assert.deepEqual(error.fields, {})
    return true
  })
}

test('video existence is checked with bound IDs after BEGIN IMMEDIATE and the operation shares that connection', t => {
  const { database } = setup(t)
  insertVideo(database, 1)
  insertVideo(database, Number.MAX_SAFE_INTEGER)
  const commands = []
  const lookups = []
  const exec = database.exec.bind(database)
  const prepare = database.prepare.bind(database)
  t.mock.method(database, 'exec', sql => { commands.push(sql); return exec(sql) })
  t.mock.method(database, 'prepare', sql => {
    assert.equal(database.isTransaction, true)
    assert.equal(commands.at(-1), 'BEGIN IMMEDIATE')
    const statement = prepare(sql)
    const get = statement.get.bind(statement)
    t.mock.method(statement, 'get', (...params) => { lookups.push(params); return get(...params) })
    return statement
  })
  for (const id of [1, Number.MAX_SAFE_INTEGER]) {
    const result = Object.freeze({ target: id })
    let calls = 0
    assert.equal(withVideoWriteTransaction(database, id, connection => {
      calls += 1
      assert.equal(connection, database)
      assert.equal(connection.isTransaction, true)
      return result
    }), result)
    assert.equal(calls, 1)
    assert.equal(database.isTransaction, false)
    assert.equal(database.isOpen, true)
  }
  assert.deepEqual(lookups, [[1], [Number.MAX_SAFE_INTEGER]])
  assert.deepEqual(commands, ['BEGIN IMMEDIATE', 'COMMIT', 'BEGIN IMMEDIATE', 'COMMIT'])
})

test('missing videos return 404 and roll back without invoking the write operation', t => {
  const { database } = setup(t)
  insertVideo(database, 1)
  const commands = []
  const exec = database.exec.bind(database)
  t.mock.method(database, 'exec', sql => { commands.push(sql); return exec(sql) })
  for (const id of [2, Number.MAX_SAFE_INTEGER]) {
    assertMissing(() => withVideoWriteTransaction(database, id, () => assert.fail('Missing targets must not reach the write')))
    assert.equal(database.isTransaction, false)
    assert.equal(database.isOpen, true)
  }
  assert.deepEqual(commands, ['BEGIN IMMEDIATE', 'ROLLBACK', 'BEGIN IMMEDIATE', 'ROLLBACK'])
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_views').get().count, 0)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM videos').get().count, 1)
})

test('a foreign key error is preserved rather than treated as a missing video or successful duplicate and earlier writes roll back', t => {
  const { database } = setup(t)
  insertVideo(database, 1)
  assert.throws(() => withVideoWriteTransaction(database, 1, connection => {
    const insert = connection.prepare('INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)')
    insert.run(1, visitorId)
    insert.run(999999, visitorId)
  }), error => {
    assert.equal(error instanceof ApiError, false)
    assert.equal(error.code, 'ERR_SQLITE_ERROR')
    assert.equal(error.errcode, 787)
    return true
  })
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_views').get().count, 0)
  assert.equal(database.isTransaction, false)
  assert.equal(database.isOpen, true)
  const result = withVideoWriteTransaction(database, 1, connection => connection.prepare(
    'INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)').run(1, visitorId))
  assert.equal(result.changes, 1)
})

test('another connection cannot delete the checked video until the write boundary commits', t => {
  const { context, path, database } = setup(t)
  insertVideo(database, 1)
  const writer = context.open(path)
  // Avoid sleeps: the competing connection must report the existing lock immediately.
  writer.exec('PRAGMA busy_timeout = 0')
  withVideoWriteTransaction(database, 1, () => {
    assert.throws(() => writer.prepare('DELETE FROM videos WHERE id = ?').run(1), error => {
      assert.equal(error.code, 'ERR_SQLITE_ERROR')
      assert.equal(error.errcode, 5)
      return true
    })
  })
  assert.equal(writer.prepare('DELETE FROM videos WHERE id = ?').run(1).changes, 1)
  assertMissing(() => withVideoWriteTransaction(database, 1, () => assert.fail('Deleted targets must not reach the write')))
})

test('wrapping an operation does not bypass synchronous callback validation or start a transaction for invalid callbacks', t => {
  const { database } = setup(t)
  const exec = t.mock.method(database, 'exec', () => assert.fail('Invalid callbacks must fail before BEGIN'))
  const prepare = t.mock.method(database, 'prepare', () => assert.fail('Invalid callbacks must fail before lookup'))
  let called = false
  for (const operation of [null, {}, async () => { called = true }, function* () { called = true },
    async function* () { called = true }]) {
    assert.throws(() => withVideoWriteTransaction(database, 1, operation),
      { name: 'TypeError', message: 'Transaction callbacks must be synchronous functions.' })
  }
  assert.equal(called, false)
  assert.equal(exec.mock.callCount(), 0)
  assert.equal(prepare.mock.callCount(), 0)
  assert.equal(database.isTransaction, false)
})

test('a failed commit preserves the error and rolls back the operation before allowing recovery', t => {
  const { database } = setup(t)
  insertVideo(database, 1)
  const failure = new Error('Injected write commit failure')
  const exec = database.exec.bind(database)
  const fault = t.mock.method(database, 'exec', sql => {
    if (sql === 'COMMIT') throw failure
    return exec(sql)
  })
  const operation = connection => connection.prepare(
    'INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)').run(1, visitorId)
  assert.throws(() => withVideoWriteTransaction(database, 1, operation), error => error === failure)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_views').get().count, 0)
  assert.equal(database.isTransaction, false)
  assert.equal(database.isOpen, true)
  fault.mock.restore()
  assert.equal(withVideoWriteTransaction(database, 1, operation).changes, 1)
})
