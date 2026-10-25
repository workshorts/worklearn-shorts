import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('tag-deletion.db')
  context.initialize(path)
  const database = context.open(path)
  assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  const ids = insertMinimalFixture(database)
  const secondVideoId = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Second video', '/uploads/videos/test-only-second.mp4').lastInsertRowid
  const insertTag = database.prepare('INSERT INTO tags (name) VALUES (?)')
  const otherTagId = insertTag.run('Retained tag').lastInsertRowid
  const unlinkedTagId = insertTag.run('Unlinked tag').lastInsertRowid
  const link = database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
  link.run(ids.videoId, otherTagId)
  link.run(secondVideoId, ids.tagId)
  link.run(secondVideoId, otherTagId)
  return { context, path, database, ...ids, secondVideoId, otherTagId, unlinkedTagId }
}

const snapshotTables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function snapshotRows(database) {
  return Object.fromEntries(snapshotTables.map(table => [
    table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))
  ]))
}

function withoutTag(before, tagId) {
  return {
    ...before,
    tags: before.tags.filter(row => row.id !== tagId),
    video_tags: before.video_tags.filter(row => row.tag_id !== tagId)
  }
}

test('deleting a shared tag removes only that tag and all its links while preserving videos and other data', { timeout: 10000 }, t => {
  const { database, tagId, otherTagId, videoId, secondVideoId } = setup(t)
  const before = snapshotRows(database)
  assert.equal(before.tags.filter(row => row.id === tagId).length, 1)
  assert.equal(before.video_tags.filter(row => row.tag_id === tagId).length, 2)
  const remove = database.prepare('DELETE FROM tags WHERE id = ?')
  // changes counts the deleted parent; inspect child rows to prove the cascade.
  assert.equal(remove.run(tagId).changes, 1)
  const expected = withoutTag(before, tagId)
  assert.deepEqual(snapshotRows(database), expected)
  assert.deepEqual(database.prepare('SELECT video_id, tag_id FROM video_tags ORDER BY video_id, tag_id')
    .all().map(row => [row.video_id, row.tag_id]), [[videoId, otherTagId], [secondVideoId, otherTagId]])
  assert.equal(remove.run(tagId).changes, 0)
  assert.deepEqual(snapshotRows(database), expected)
  assert.equal(database.isTransaction, false)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('deleting an unlinked tag or an absent tag leaves existing links and all unrelated rows unchanged', { timeout: 10000 }, t => {
  const { database, unlinkedTagId } = setup(t)
  const before = snapshotRows(database)
  assert.equal(before.tags.filter(row => row.id === unlinkedTagId).length, 1)
  assert.equal(before.video_tags.filter(row => row.tag_id === unlinkedTagId).length, 0)
  const remove = database.prepare('DELETE FROM tags WHERE id = ?')
  assert.equal(remove.run(unlinkedTagId).changes, 1)
  const expected = withoutTag(before, unlinkedTagId)
  assert.deepEqual(snapshotRows(database), expected)
  const missingId = 999999
  assert.equal(database.prepare('SELECT id FROM tags WHERE id = ?').get(missingId), undefined)
  assert.equal(remove.run(missingId).changes, 0)
  assert.deepEqual(snapshotRows(database), expected)
  assert.equal(database.isTransaction, false)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('tag deletion is visible across connections and persists after reopening without restoring old links', { timeout: 10000 }, t => {
  const { context, path, database, tagId } = setup(t)
  const before = snapshotRows(database)
  const expected = withoutTag(before, tagId)
  const second = context.open(path)
  assert.deepEqual(snapshotRows(second), before)
  assert.equal(second.prepare('DELETE FROM tags WHERE id = ?').run(tagId).changes, 1)
  assert.deepEqual(snapshotRows(second), expected)
  assert.deepEqual(snapshotRows(database), expected)
  database.close()
  second.close()

  const reopened = context.open(path)
  assert.deepEqual(snapshotRows(reopened), expected)
  assert.equal(reopened.prepare('DELETE FROM tags WHERE id = ?').run(tagId).changes, 0)
  assert.deepEqual(snapshotRows(reopened), expected)
  // The normalized name can be reused, but a new tag must not inherit old links.
  const name = ' FIXTURE TAG '
  const result = reopened.prepare('INSERT INTO tags (name) VALUES (?)').run(name)
  assert.equal(result.changes, 1)
  assert.ok(result.lastInsertRowid > Math.max(...before.tags.map(row => row.id)))
  assert.deepEqual(snapshotRows(reopened), {
    ...expected,
    tags: [...expected.tags, { id: result.lastInsertRowid, name }],
    sqlite_sequence: expected.sqlite_sequence.map(row => row.name === 'tags'
      ? { ...row, seq: result.lastInsertRowid } : row)
  })
  assert.equal(reopened.isTransaction, false)
  assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
})
