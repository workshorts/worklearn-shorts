import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { deleteVideoLike } from '../../src/db/video-like-writes.js'
import { removeVideoLike } from '../../src/services/video-like.js'
import { withVideoWriteTransaction } from '../../src/services/video-write.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const visitorA = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const visitorB = '12345678-abcd-4abc-9def-012345abcdef'
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('video-like-delete.db')
  context.initialize(path)
  const database = context.open(path)
  return { context, path, database, ...insertMinimalFixture(database) }
}

function snapshot(database, path) {
  return {
    rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }
}

function assertReady(database) {
  assert.equal(database.isTransaction, false)
  assert.equal(database.isOpen, true)
}

test('deletion removes only the bound video and visitor pair and preserves all remaining rows and times', t => {
  const { database, path, videoId, visitorId } = setup(t)
  const otherId = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Other delete target', 'videos/10000000-0000-4000-8000-000000000002.mp4').lastInsertRowid
  const insert = database.prepare('INSERT INTO video_likes (video_id, visitor_id, created_at) VALUES (?, ?, ?)')
  for (const [id, visitor] of [[videoId, visitorA], [otherId, visitorId], [otherId, visitorA]]) {
    insert.run(id, visitor, '2001-02-03T04:05:06.000Z')
  }
  const before = snapshot(database, path)
  assert.equal(removeVideoLike(database, { id: videoId, visitorId }).changes, 1)
  assertReady(database)
  const after = snapshot(database, path)
  assert.deepEqual(after.rows.video_likes,
    before.rows.video_likes.filter(row => !(row.video_id === videoId && row.visitor_id === visitorId)))
  for (const table of tables.filter(table => table !== 'video_likes')) {
    assert.deepEqual(after.rows[table], before.rows[table])
  }
  assert.deepEqual(after.schema, before.schema)
})

test('an absent pair and repeated deletion return zero changes without changing the database file', t => {
  const { database, path, videoId, visitorId } = setup(t)
  const before = snapshot(database, path)
  assert.equal(removeVideoLike(database, { id: videoId, visitorId: visitorB }).changes, 0)
  assertReady(database)
  assert.deepEqual(snapshot(database, path), before)
  assert.equal(removeVideoLike(database, { id: videoId, visitorId }).changes, 1)
  const saved = snapshot(database, path)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(removeVideoLike(database, { id: videoId, visitorId }).changes, 0)
    assertReady(database)
    assert.deepEqual(snapshot(database, path), saved)
  }
})

test('the raw delete requires an active caller transaction before preparing SQL', t => {
  const { database, path, videoId, visitorId } = setup(t)
  const before = snapshot(database, path)
  const prepare = t.mock.method(database, 'prepare', () => assert.fail('No SQL is allowed before the delete guard'))
  try {
    assert.throws(() => deleteVideoLike(database, { videoId, visitorId }),
      { message: 'Video like deletion requires an active transaction.' })
    assert.equal(prepare.mock.callCount(), 0)
  } finally { prepare.mock.restore() }
  assertReady(database)
  assert.deepEqual(snapshot(database, path), before)
})

test('a missing parent is still a 404 rather than a successful absent-pair deletion', t => {
  const { database, path, visitorId } = setup(t)
  const before = snapshot(database, path)
  for (const id of [999999, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => removeVideoLike(database, { id, visitorId }), error => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 404)
      assert.equal(error.code, 'NOT_FOUND')
      assert.equal(error.message, '영상을 찾을 수 없습니다.')
      assert.deepEqual(error.fields, {})
      return true
    })
    assertReady(database)
    assert.deepEqual(snapshot(database, path), before)
  }
})

test('the maximum video ID and visitor are bound on the same active connection before commit', t => {
  const { database } = setup(t)
  const id = Number.MAX_SAFE_INTEGER
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
    .run(id, 'Maximum delete target', 'videos/10000000-0000-4000-8000-000000000003.mp4')
  database.prepare('INSERT INTO video_likes (video_id, visitor_id) VALUES (?, ?)').run(id, visitorA)
  const commands = []
  const parameters = []
  const exec = database.exec.bind(database)
  const prepare = database.prepare.bind(database)
  t.mock.method(database, 'exec', sql => { commands.push(sql); return exec(sql) })
  t.mock.method(database, 'prepare', sql => {
    const statement = prepare(sql)
    if (sql.startsWith('DELETE FROM video_likes')) {
      const run = statement.run.bind(statement)
      statement.run = (...params) => {
        assert.equal(database.isTransaction, true)
        assert.deepEqual(commands, ['BEGIN IMMEDIATE'])
        parameters.push(params)
        return run(...params)
      }
    }
    return statement
  })
  assert.equal(removeVideoLike(database, { id, visitorId: visitorA }).changes, 1)
  assert.deepEqual(parameters, [[id, visitorA]])
  assert.deepEqual(commands, ['BEGIN IMMEDIATE', 'COMMIT'])
  assertReady(database)
})

test('a native trigger failure restores the deleted like and earlier trigger writes before recovery', t => {
  const { database, path, videoId, visitorId } = setup(t)
  // The trigger exists only in this owned DB and fails after changing another table.
  database.exec(`CREATE TRIGGER test_like_delete_failure AFTER DELETE ON video_likes BEGIN
    UPDATE videos SET title = 'private-delete-trigger' WHERE id = OLD.video_id;
    INSERT INTO video_tags (video_id, tag_id) VALUES (OLD.video_id, -1);
  END`)
  const before = snapshot(database, path)
  try {
    assert.throws(() => removeVideoLike(database, { id: videoId, visitorId }), error => {
      assert.equal(error instanceof ApiError, false)
      assert.equal(error.code, 'ERR_SQLITE_ERROR')
      assert.equal(error.errcode, 787)
      return true
    })
    assertReady(database)
    assert.deepEqual(snapshot(database, path), before)
  } finally { database.exec('DROP TRIGGER test_like_delete_failure') }
  assert.equal(removeVideoLike(database, { id: videoId, visitorId }).changes, 1)
  assert.equal(removeVideoLike(database, { id: videoId, visitorId }).changes, 0)
})

test('a failed delete commit preserves the error and restores the original row identity and timestamp', t => {
  const { database, path, videoId, visitorId } = setup(t)
  const before = snapshot(database, path)
  const failure = new Error('Injected delete commit failure')
  const exec = database.exec.bind(database)
  const fault = t.mock.method(database, 'exec', sql => {
    if (sql === 'COMMIT') throw failure
    return exec(sql)
  })
  try {
    assert.throws(() => removeVideoLike(database, { id: videoId, visitorId }), error => error === failure)
  } finally { fault.mock.restore() }
  assertReady(database)
  assert.deepEqual(snapshot(database, path), before)
  assert.equal(removeVideoLike(database, { id: videoId, visitorId }).changes, 1)
  assert.equal(removeVideoLike(database, { id: videoId, visitorId }).changes, 0)
})

test('the raw delete leaves commit ownership to the caller and another connection sees only committed deletion', t => {
  const { context, path, database, videoId, visitorId } = setup(t)
  const other = context.open(path)
  const readPair = connection => connection.prepare('SELECT COUNT(*) AS count FROM video_likes WHERE video_id = ? AND visitor_id = ?')
    .get(videoId, visitorId).count
  const before = snapshot(database, path)
  const failure = new Error('Injected failure after raw deletion')
  assert.throws(() => withVideoWriteTransaction(database, videoId, connection => {
    assert.equal(deleteVideoLike(connection, { videoId, visitorId }).changes, 1)
    assert.equal(connection.isTransaction, true)
    assert.equal(readPair(connection), 0)
    assert.equal(readPair(other), 1)
    throw failure
  }), error => error === failure)
  assertReady(database)
  assert.deepEqual(snapshot(database, path), before)
  assert.equal(readPair(other), 1)
  assert.equal(removeVideoLike(database, { id: videoId, visitorId }).changes, 1)
  assert.equal(readPair(other), 0)
})

test('committed deletion stays absent across independent writer connections and reopening', t => {
  const { context, path, database, videoId, visitorId } = setup(t)
  assert.equal(removeVideoLike(database, { id: videoId, visitorId }).changes, 1)
  const saved = snapshot(database, path)
  const other = context.open(path)
  assert.equal(removeVideoLike(other, { id: videoId, visitorId }).changes, 0)
  assertReady(other)
  assert.deepEqual(snapshot(other, path), saved)
  database.close()
  other.close()
  const reopened = context.open(path)
  assert.equal(removeVideoLike(reopened, { id: videoId, visitorId }).changes, 0)
  assertReady(reopened)
  assert.deepEqual(snapshot(reopened, path), saved)
  assert.equal(reopened.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
})
