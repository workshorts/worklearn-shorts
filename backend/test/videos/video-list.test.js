import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { countVideos } from '../../src/db/video-page-queries.js'
import { loadVideos } from '../../src/db/video-queries.js'
import { withTransaction } from '../../src/db/transaction.js'
import { loadVideoList } from '../../src/services/video-read.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const videoPath = 'videos/10000000-0000-4000-8000-000000000001.mp4'
const keys = ['id', 'title', 'description', 'tags', 'videoUrl', 'thumbnailUrl', 'viewCount', 'likeCount',
  'likedByMe', 'commentCount', 'hasQuiz', 'createdAt', 'updatedAt']

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('video-list.db')
  context.initialize(path)
  return { context, path, database: context.open(path) }
}

function insertVideo(database, id, path = videoPath) {
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
    .run(id, 'List video ' + id, path)
}

function fixture(database) {
  const result = insertMinimalFixture(database)
  database.prepare('UPDATE videos SET video_path = ? WHERE id = ?').run(videoPath, result.videoId)
  return result
}

test('video list assembles only the selected page in descending order using the complete shared Video and visitor context', t => {
  const { database } = setup(t)
  const { videoId, visitorId } = fixture(database)
  for (const id of [7, 11, 4]) insertVideo(database, id)
  database.exec('PRAGMA query_only = ON')
  try {
    for (const visitor of [null, visitorId, 'aabbccdd-eeff-4abc-8def-012345abcdef']) {
      const expected = loadVideos(database, {
        where: 'WHERE v.id IN (?, ?)', params: [4, videoId], orderBy: 'v.id DESC', visitorId: visitor,
      })
      const result = loadVideoList(database, { page: 2, limit: 2, visitorId: visitor })
      assert.deepEqual(result, { data: expected, total: 4 })
      assert.deepEqual(result.data.map(video => video.id), [4, videoId])
      for (const video of result.data) assert.deepEqual(Object.keys(video).sort(), [...keys].sort())
      assert.equal(result.data[1].likedByMe, visitor === visitorId)
      assert.equal(database.isTransaction, false)
      assert.equal(database.isOpen, true)
    }
  } finally {
    database.exec('PRAGMA query_only = OFF')
  }
})

test('empty video pages retain their total without loading malformed videos outside the selected page', t => {
  const { database } = setup(t)
  assert.deepEqual(loadVideoList(database, { page: 1, limit: 20 }), { data: [], total: 0 })
  insertVideo(database, 1, 'invalid-stored-path')
  assert.deepEqual(loadVideoList(database, { page: 2, limit: 1 }), { data: [], total: 1 })
  assert.deepEqual(loadVideoList(database, { page: Number.MAX_SAFE_INTEGER, limit: 50 }), { data: [], total: 1 })
  assert.equal(database.isTransaction, false)
})

test('video list total, page membership and shared relations use one snapshot despite a concurrent committed deletion', t => {
  const { context, path, database } = setup(t)
  const { videoId, visitorId } = fixture(database)
  insertVideo(database, 2)
  const expected = loadVideos(database, { where: 'WHERE v.id = ?', params: [videoId], visitorId })
  // Only this owned temporary DB uses WAL to allow a writer during the service read.
  assert.equal(database.prepare('PRAGMA journal_mode = WAL').get().journal_mode, 'wal')
  const writer = context.open(path)
  const prepare = database.prepare.bind(database)
  let changed = false
  const observed = t.mock.method(database, 'prepare', sql => {
    assert.equal(database.isTransaction, true, 'Every service query must share its read transaction')
    const statement = prepare(sql)
    if (sql.includes('LIMIT ? OFFSET ?')) {
      const all = statement.all.bind(statement)
      t.mock.method(statement, 'all', (...params) => {
        const rows = all(...params)
        withTransaction(writer, connection => {
          connection.prepare('DELETE FROM videos WHERE id = ?').run(videoId)
          insertVideo(connection, 3)
          insertVideo(connection, 4)
        })
        changed = true
        assert.equal(countVideos(writer), 3)
        return rows
      })
    }
    return statement
  })
  const result = loadVideoList(database, { page: 2, limit: 1, visitorId })
  assert.equal(changed, true)
  assert.deepEqual(result, { data: expected, total: 2 })
  assert.equal(database.isTransaction, false)
  observed.mock.restore()
  const current = loadVideoList(database, { page: 1, limit: 20, visitorId })
  assert.equal(current.total, 3)
  assert.deepEqual(current.data.map(video => video.id), [4, 3, 2])
})

test('a selected video mapping failure returns no partial list and rolls back before subsequent recovery', t => {
  const { database } = setup(t)
  insertVideo(database, 1, 'invalid-stored-path')
  insertVideo(database, 2)
  assert.throws(() => loadVideoList(database, { page: 1, limit: 2 }), error => {
    assert.equal(error instanceof ApiError, false)
    assert.equal(error.message, 'Invalid stored video path.')
    return true
  })
  assert.equal(database.isTransaction, false)
  assert.equal(database.isOpen, true)
  database.prepare('UPDATE videos SET video_path = ? WHERE id = ?').run(videoPath, 1)
  const recovered = loadVideoList(database, { page: 1, limit: 2 })
  assert.equal(recovered.total, 2)
  assert.deepEqual(recovered.data.map(video => video.id), [2, 1])
})

test('video list waits for commit and preserves a commit failure while rolling back and retaining a usable connection', t => {
  const { database } = setup(t)
  insertVideo(database, 1)
  const failure = new Error('Test list commit failure')
  const commands = []
  const exec = database.exec.bind(database)
  const observed = t.mock.method(database, 'exec', sql => {
    commands.push(sql)
    if (sql === 'COMMIT') throw failure
    return exec(sql)
  })
  assert.throws(() => loadVideoList(database, { page: 1, limit: 20 }), error => error === failure)
  assert.deepEqual(commands, ['BEGIN', 'COMMIT', 'ROLLBACK'])
  assert.equal(database.isTransaction, false)
  assert.equal(database.isOpen, true)
  observed.mock.restore()
  assert.equal(loadVideoList(database, { page: 1, limit: 20 }).data[0].id, 1)
})
