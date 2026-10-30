import assert from 'node:assert/strict'
import test from 'node:test'
import { countVideos, loadVideoPageIds } from '../../src/db/video-page-queries.js'
import { withTransaction } from '../../src/db/transaction.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('video-total.db')
  context.initialize(path)
  return { context, path, database: context.open(path) }
}

function insertVideo(database, title) {
  return database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run(title, 'videos/10000000-0000-4000-8000-000000000001.mp4').lastInsertRowid
}

test('video total counts actual rows independently of page size, empty pages and the largest allocated ID', t => {
  const { database } = setup(t)
  assert.equal(countVideos(database), 0)
  for (let index = 0; index < 51; index += 1) insertVideo(database, 'Total video ' + index)

  for (const [page, limit, length] of [[1, 1, 1], [2, 20, 20], [3, 20, 11], [2, 50, 1],
    [4, 20, 0], [Number.MAX_SAFE_INTEGER, 50, 0]]) {
    const result = withTransaction(database, connection => ({
      total: countVideos(connection), ids: loadVideoPageIds(connection, { page, limit }),
    }), { mode: 'DEFERRED' })
    assert.equal(result.total, 51)
    assert.equal(result.ids.length, length)
  }

  database.prepare('DELETE FROM videos WHERE id < ?').run(51)
  assert.equal(countVideos(database), 1)
  database.exec('DELETE FROM videos')
  assert.equal(countVideos(database), 0)
})

test('video total includes unlinked videos and is not multiplied by tags, courses or activity rows', t => {
  const { database } = setup(t)
  const { videoId } = insertMinimalFixture(database)
  insertVideo(database, 'Unlinked video')
  const tagId = database.prepare('INSERT INTO tags (name) VALUES (?)').run('Second tag').lastInsertRowid
  const courseId = database.prepare('INSERT INTO courses (name) VALUES (?)').run('Second course').lastInsertRowid
  database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(videoId, tagId)
  database.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)')
    .run(courseId, videoId, 1)
  for (const table of ['video_views', 'video_likes']) {
    database.prepare(`INSERT INTO ${table} (video_id, visitor_id) VALUES (?, ?)`)
      .run(videoId, 'aabbccdd-eeff-4abc-8def-012345abcdef')
  }
  database.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)')
    .run(videoId, 'Second visitor', 'test-only-placeholder', 'Second comment')
  assert.equal(countVideos(database), 2)
})

test('video total and page IDs share the caller snapshot despite committed changes from another connection', t => {
  const { context, path, database } = setup(t)
  // WAL is confined to this owned temporary DB so a writer can commit during the read.
  assert.equal(database.prepare('PRAGMA journal_mode = WAL').get().journal_mode, 'wal')
  const writer = context.open(path)
  insertVideo(database, 'Original first video')
  insertVideo(database, 'Original second video')
  database.exec('PRAGMA query_only = ON')
  try {
    const result = withTransaction(database, connection => {
      const total = countVideos(connection)
      assert.equal(total, 2)
      withTransaction(writer, writeConnection => {
        insertVideo(writeConnection, 'Concurrent third video')
        insertVideo(writeConnection, 'Concurrent fourth video')
        writeConnection.prepare('DELETE FROM videos WHERE id = ?').run(1)
      })
      assert.equal(countVideos(writer), 3)
      assert.equal(countVideos(connection), total)
      const ids = loadVideoPageIds(connection, { page: 1, limit: 50 })
      assert.equal(connection.isTransaction, true)
      return { total, ids }
    }, { mode: 'DEFERRED' })
    assert.deepEqual(result, { total: 2, ids: [2, 1] })
    assert.equal(database.isTransaction, false)
    assert.equal(database.isOpen, true)
    assert.equal(countVideos(database), 3)
    assert.deepEqual(loadVideoPageIds(database, { page: 1, limit: 50 }), [4, 3, 2])
  } finally {
    database.exec('PRAGMA query_only = OFF')
  }
})
