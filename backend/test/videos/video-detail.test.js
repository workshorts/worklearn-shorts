import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { loadVideos } from '../../src/db/video-queries.js'
import { loadVideoDetail } from '../../src/services/video-read.js'
import { createDatabaseContext } from '../helpers/database-context.js'

const visitorId = 'aabbccdd-eeff-4abc-8def-012345abcdef'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('video-detail.db')
  context.initialize(path)
  return context.open(path)
}

function insertVideo(database, id, title) {
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
    .run(id, title, `videos/10000000-0000-4000-8000-${String(id).slice(-12).padStart(12, '0')}.mp4`)
}

test('video detail selects only the requested ID and forwards the shared loader result and visitor context unchanged', t => {
  const database = setup(t)
  insertVideo(database, 1, 'First video')
  insertVideo(database, Number.MAX_SAFE_INTEGER, 'Safe boundary video')
  database.prepare('INSERT INTO video_likes (video_id, visitor_id) VALUES (?, ?)').run(1, visitorId)
  for (const id of [1, Number.MAX_SAFE_INTEGER]) {
    for (const visitor of [null, visitorId]) {
      const expected = loadVideos(database, { where: 'WHERE v.id = ?', params: [id], visitorId: visitor })[0]
      const result = loadVideoDetail(database, { id, visitorId: visitor })
      assert.equal(result.id, id)
      assert.equal(result.title, id === 1 ? 'First video' : 'Safe boundary video')
      assert.deepEqual(result, expected)
    }
  }
})

test('video detail returns a controlled not-found error for valid missing IDs in empty and populated databases', t => {
  const database = setup(t)
  function assertMissing(id) {
    assert.throws(() => loadVideoDetail(database, { id }), error => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 404)
      assert.equal(error.code, 'NOT_FOUND')
      assert.equal(error.message, '영상을 찾을 수 없습니다.')
      assert.deepEqual(error.fields, {})
      assert.deepEqual(error.headers, {})
      return true
    })
    assert.equal(database.isTransaction, false)
    assert.equal(database.isOpen, true)
  }
  assertMissing(1)
  insertVideo(database, 1, 'Unrelated video')
  assertMissing(2)
  assertMissing(Number.MAX_SAFE_INTEGER)
})

test('video detail reads through the supplied connection in one caller-independent deferred transaction', t => {
  const database = setup(t)
  insertVideo(database, 1, 'Snapshot video')
  const commands = []
  const reads = []
  const exec = database.exec.bind(database)
  const prepare = database.prepare.bind(database)
  t.mock.method(database, 'exec', sql => { commands.push(sql); return exec(sql) })
  t.mock.method(database, 'prepare', sql => {
    const statement = prepare(sql)
    const all = statement.all.bind(statement)
    t.mock.method(statement, 'all', (...params) => {
      reads.push({ active: database.isTransaction, params })
      return all(...params)
    })
    return statement
  })
  assert.equal(loadVideoDetail(database, { id: 1, visitorId }).id, 1)
  assert.deepEqual(commands, ['BEGIN', 'COMMIT'])
  assert.ok(reads.length > 0)
  assert.ok(reads.every(read => read.active))
  assert.deepEqual(reads[0].params, [visitorId, 1])
  assert.equal(database.isTransaction, false)
  assert.equal(database.isOpen, true)
})

test('video detail propagates native database failures without reporting a missing video and supports recovery', t => {
  const database = setup(t)
  insertVideo(database, 1, 'Recoverable video')
  database.exec('ALTER TABLE videos RENAME TO unavailable_videos')
  try {
    assert.throws(() => loadVideoDetail(database, { id: 1 }), error => {
      assert.equal(error instanceof ApiError, false)
      assert.equal(error.code, 'ERR_SQLITE_ERROR')
      return true
    })
    assert.equal(database.isTransaction, false)
    assert.equal(database.isOpen, true)
  } finally {
    database.exec('ALTER TABLE unavailable_videos RENAME TO videos')
  }
  assert.equal(loadVideoDetail(database, { id: 1 }).id, 1)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('video detail waits for a successful commit and preserves a commit failure rather than returning data', t => {
  const database = setup(t)
  insertVideo(database, 1, 'Commit guarded video')
  const failure = new Error('Test read commit failure')
  const commands = []
  const exec = database.exec.bind(database)
  const injected = t.mock.method(database, 'exec', sql => {
    commands.push(sql)
    if (sql === 'COMMIT') throw failure
    return exec(sql)
  })
  assert.throws(() => loadVideoDetail(database, { id: 1 }), error => error === failure)
  assert.deepEqual(commands, ['BEGIN', 'COMMIT', 'ROLLBACK'])
  assert.equal(database.isTransaction, false)
  assert.equal(database.isOpen, true)
  injected.mock.restore()
  assert.equal(loadVideoDetail(database, { id: 1 }).id, 1)
})
