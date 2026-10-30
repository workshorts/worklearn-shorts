import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { recordVideoView } from '../../src/services/video-view.js'
import { createDatabaseContext } from '../helpers/database-context.js'

const visitorA = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const visitorB = '12345678-abcd-4abc-9def-012345abcdef'

function setup(t, ids = [1]) {
  const context = createDatabaseContext(t)
  const path = context.path('video-view.db')
  context.initialize(path)
  const database = context.open(path)
  const insert = database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
  for (const id of ids) insert.run(id, 'Counted target ' + id, 'videos/10000000-0000-4000-8000-000000000001.mp4')
  return { context, path, database }
}

test('recording returns boolean true only for the committed new pair and preserves the requested boundary ID', t => {
  const { database } = setup(t, [1, Number.MAX_SAFE_INTEGER])
  const id = Number.MAX_SAFE_INTEGER
  const first = recordVideoView(database, { id, visitorId: visitorA })
  assert.equal(first.videoId, id)
  assert.equal(first.counted, true)
  assert.equal(typeof first.counted, 'boolean')
  assert.ok(database.prepare('SELECT last_insert_rowid() AS id').get().id > 0)
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const repeated = recordVideoView(database, { id, visitorId: visitorA })
    assert.equal(repeated.videoId, id)
    assert.equal(repeated.counted, false)
    assert.equal(typeof repeated.counted, 'boolean')
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_views WHERE video_id = ?').get(id).count, 1)
  assert.equal(database.isTransaction, false)
  assert.equal(database.isOpen, true)
})

test('counted is determined independently for each video and visitor pair', t => {
  const { database } = setup(t, [1, 2])
  const pairs = [[1, visitorA], [1, visitorB], [2, visitorA]]
  for (const [id, visitorId] of pairs) {
    const result = recordVideoView(database, { id, visitorId })
    assert.equal(result.videoId, id)
    assert.equal(result.counted, true)
  }
  for (const [id, visitorId] of pairs) assert.equal(recordVideoView(database, { id, visitorId }).counted, false)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_views').get().count, 3)
})

test('missing videos and database failures throw instead of returning a false counted result and support recovery', t => {
  const { database } = setup(t)
  assert.throws(() => recordVideoView(database, { id: 2, visitorId: visitorA }), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 404)
    assert.equal(error.code, 'NOT_FOUND')
    return true
  })
  database.exec('ALTER TABLE video_views RENAME TO unavailable_video_views')
  try {
    assert.throws(() => recordVideoView(database, { id: 1, visitorId: visitorA }), error => {
      assert.equal(error instanceof ApiError, false)
      assert.equal(error.code, 'ERR_SQLITE_ERROR')
      return true
    })
    assert.equal(database.isTransaction, false)
    assert.equal(database.isOpen, true)
  } finally {
    database.exec('ALTER TABLE unavailable_video_views RENAME TO video_views')
  }
  assert.equal(recordVideoView(database, { id: 1, visitorId: visitorA }).counted, true)
})

test('a failed commit returns no successful counted result and a rolled-back pair is still new on retry', t => {
  const { database } = setup(t)
  const failure = new Error('Injected counted commit failure')
  const exec = database.exec.bind(database)
  const fault = t.mock.method(database, 'exec', sql => {
    if (sql === 'COMMIT') throw failure
    return exec(sql)
  })
  assert.throws(() => recordVideoView(database, { id: 1, visitorId: visitorA }), error => error === failure)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_views').get().count, 0)
  assert.equal(database.isTransaction, false)
  assert.equal(database.isOpen, true)
  fault.mock.restore()
  assert.equal(recordVideoView(database, { id: 1, visitorId: visitorA }).counted, true)
  assert.equal(recordVideoView(database, { id: 1, visitorId: visitorA }).counted, false)
})

test('a committed pair is counted false by a different actual database connection', t => {
  const { context, path, database } = setup(t)
  assert.equal(recordVideoView(database, { id: 1, visitorId: visitorA }).counted, true)
  const other = context.open(path)
  const repeated = recordVideoView(other, { id: 1, visitorId: visitorA })
  assert.equal(repeated.videoId, 1)
  assert.equal(repeated.counted, false)
  assert.equal(other.prepare('SELECT COUNT(*) AS count FROM video_views').get().count, 1)
})
