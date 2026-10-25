import assert from 'node:assert/strict'
import test from 'node:test'
import { withTransaction } from '../../src/db/transaction.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('transaction-rollback.db')
  context.initialize(path)
  const database = context.open(path)
  assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  const ids = insertMinimalFixture(database)
  const observer = context.open(path)
  return { context, path, database, observer, ...ids }
}

const videoChildTables = ['course_videos', 'video_tags', 'video_views', 'video_likes', 'comments', 'quizzes']
const snapshotTables = ['admins', 'videos', 'tags', 'courses', ...videoChildTables, 'quiz_options', 'sqlite_sequence']

function snapshotRows(database) {
  return Object.fromEntries(snapshotTables.map(table => [
    table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))
  ]))
}

function insertRelatedRows(database, originalIds) {
  database.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
    .run('transaction-admin', 'test-only-placeholder')
  const videoId = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Transaction video', '/uploads/videos/test-only-transaction.mp4').lastInsertRowid
  const tagId = database.prepare('INSERT INTO tags (name) VALUES (?)').run('Transaction tag').lastInsertRowid
  const courseId = database.prepare('INSERT INTO courses (name) VALUES (?)').run('Transaction course').lastInsertRowid
  database.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)').run(courseId, videoId, 1)
  database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(videoId, tagId)
  for (const table of ['video_views', 'video_likes']) {
    database.prepare(`INSERT INTO ${table} (video_id, visitor_id) VALUES (?, ?)`).run(videoId, originalIds.visitorId)
  }
  database.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)')
    .run(videoId, 'Test user', 'test-only-placeholder', 'Transaction comment')
  const quizId = database.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)')
    .run(videoId, 'Transaction question?').lastInsertRowid
  const insertOption = database.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
  insertOption.run(quizId, 'Transaction correct option', 1, 1)
  insertOption.run(quizId, 'Transaction incorrect option', 2, 0)
  database.prepare('UPDATE videos SET title = ?, updated_at = ? WHERE id = ?')
    .run('Changed original video', '2001-02-03T04:05:06.007Z', originalIds.videoId)
  database.prepare('UPDATE comments SET content = ? WHERE id = ?').run('Changed original comment', originalIds.commentId)
  database.prepare('UPDATE quizzes SET question = ? WHERE id = ?').run('Changed original question?', originalIds.quizId)
  return { videoId, tagId, courseId, quizId }
}

function assertRestoredAndReusable(state, before) {
  const { context, path, database, observer } = state
  assert.equal(database.isOpen, true)
  assert.equal(database.isTransaction, false)
  assert.deepEqual(snapshotRows(database), before)
  assert.deepEqual(snapshotRows(observer), before)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
  let callbackResult
  const result = withTransaction(database, connection => {
    callbackResult = connection.prepare('INSERT INTO tags (name) VALUES (?)').run('After rollback')
    return callbackResult
  })
  assert.equal(result, callbackResult)
  assert.equal(result.changes, 1)
  assert.equal(result.lastInsertRowid, before.sqlite_sequence.find(row => row.name === 'tags').seq + 1)
  const expected = {
    ...before,
    tags: [...before.tags, { id: result.lastInsertRowid, name: 'After rollback' }],
    sqlite_sequence: before.sqlite_sequence.map(row => row.name === 'tags' ? { ...row, seq: result.lastInsertRowid } : row)
  }
  assert.equal(database.isTransaction, false)
  assert.deepEqual(snapshotRows(database), expected)
  assert.deepEqual(snapshotRows(observer), expected)
  database.close()
  observer.close()
  const reopened = context.open(path)
  assert.deepEqual(snapshotRows(reopened), expected)
  assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
}

const failureCases = [
  { label: 'UNIQUE', code: 2067,
    fail: database => database.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
      .run('fixture-admin', 'different-test-only-placeholder') },
  { label: 'foreign-key', code: 787,
    fail: (database, ids) => database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
      .run(ids.videoId, 999999) },
  { label: 'CHECK in DEFERRED mode', code: 275, options: { mode: 'DEFERRED' },
    fail: (database, ids) => database.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
      .run(ids.quizId, 'Invalid flag', 3, 2) },
  { label: 'callback', fail: (_database, _ids, cause) => { throw cause } }
]

for (const { label, code, options, fail } of failureCases) {
  test(`${label} failure rolls back inserts in all eleven tables, updates and sequences`, { timeout: 10000 }, t => {
    const state = setup(t)
    const { database, observer } = state
    const before = snapshotRows(database)
    const cause = new Error('Test-only callback failure')
    let originalError
    let reachedFailure = false
    assert.throws(() => withTransaction(database, connection => {
      assert.equal(connection, database)
      assert.equal(connection.isTransaction, true)
      const ids = insertRelatedRows(connection, state)
      const pending = snapshotRows(connection)
      for (const table of snapshotTables) {
        assert.notDeepEqual(pending[table], before[table])
      }
      // An independent connection must not see provisional writes.
      assert.deepEqual(snapshotRows(observer), before)
      reachedFailure = true
      try {
        fail(connection, ids, cause)
      } catch (error) {
        originalError = error
        throw error
      }
      assert.fail('The intended failure did not occur.')
    }, options), error => {
      assert.equal(error, originalError)
      if (code !== undefined) {
        assert.equal(error.code, 'ERR_SQLITE_ERROR')
        assert.equal(error.errcode, code)
      } else {
        assert.equal(error, cause)
      }
      return true
    })
    assert.equal(reachedFailure, true)
    assertRestoredAndReusable(state, before)
  })
}

function withoutParent(before, table, id) {
  const expected = { ...before, [table]: before[table].filter(row => row.id !== id) }
  if (table === 'videos') {
    const quizIds = new Set(before.quizzes.filter(row => row.video_id === id).map(row => row.id))
    for (const child of videoChildTables) {
      expected[child] = before[child].filter(row => row.video_id !== id)
    }
    expected.quiz_options = before.quiz_options.filter(row => !quizIds.has(row.quiz_id))
  } else if (table === 'quizzes') {
    expected.quiz_options = before.quiz_options.filter(row => row.quiz_id !== id)
  } else if (table === 'tags') {
    expected.video_tags = before.video_tags.filter(row => row.tag_id !== id)
  } else if (table === 'courses') {
    expected.course_videos = before.course_videos.filter(row => row.course_id !== id)
  }
  return expected
}

for (const [table, key] of [['tags', 'tagId'], ['courses', 'courseId'], ['quizzes', 'quizId'], ['videos', 'videoId']]) {
  test(`callback failure restores ${table} deletion and every cascaded row after earlier writes`, { timeout: 10000 }, t => {
    const state = setup(t)
    const { database, observer } = state
    const before = snapshotRows(database)
    const cause = new Error('Test-only failure after cascade')
    let reachedFailure = false
    assert.throws(() => withTransaction(database, connection => {
      assert.equal(connection.isTransaction, true)
      const tagId = connection.prepare('INSERT INTO tags (name) VALUES (?)').run('Provisional tag').lastInsertRowid
      assert.equal(connection.prepare('UPDATE quizzes SET question = ? WHERE id = ?')
        .run('Changed question before deletion?', state.quizId).changes, 1)
      const pending = snapshotRows(connection)
      assert.equal(pending.tags.length, before.tags.length + 1)
      assert.equal(pending.sqlite_sequence.find(row => row.name === 'tags').seq, tagId)
      assert.equal(connection.prepare(`DELETE FROM ${table} WHERE id = ?`).run(state[key]).changes, 1)
      const expected = withoutParent(pending, table, state[key])
      assert.notDeepEqual(expected, pending)
      assert.deepEqual(snapshotRows(connection), expected)
      assert.deepEqual(snapshotRows(observer), before)
      reachedFailure = true
      throw cause
    }), error => error === cause)
    assert.equal(reachedFailure, true)
    assertRestoredAndReusable(state, before)
  })
}
