import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadTagList } from '../../src/db/tag-queries.js'
import { withTransaction } from '../../src/db/transaction.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('tag-list.db')
  context.initialize(path)
  return { context, path, database: context.open(path) }
}

function snapshot(database, path) {
  return {
    rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }
}

function assertReadOnlyList(database, path, expected) {
  const before = snapshot(database, path)
  const transaction = database.isTransaction
  const rows = loadTagList(database)
  assert.deepEqual(rows.map(row => ({ ...row })), expected)
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'name'])
    assert.equal(Number.isSafeInteger(row.id) && row.id > 0, true)
    assert.equal(typeof row.name, 'string')
  }
  assert.deepEqual(snapshot(database, path), before)
  assert.equal(database.isTransaction, transaction)
  assert.equal(database.isOpen, true)
}

test('an empty tag table returns an empty list without creating defaults or modifying the database', t => {
  const { database, path } = setup(t)
  database.exec('PRAGMA query_only = ON')
  assertReadOnlyList(database, path, [])
  assertReadOnlyList(database, path, [])
})

test('all linked and unlinked tags appear once in fixed name order beyond the original four or seven tags', t => {
  const { database, path } = setup(t)
  const fixture = insertMinimalFixture(database)
  const ids = new Map([['Fixture tag', fixture.tagId]])
  const insert = database.prepare('INSERT INTO tags (name) VALUES (?)')
  for (const name of ['엑셀', '개발', 'Zulu', 'beta', 'Alpha', 'Éclair', '기획/PM', '데이터 분석', '비즈니스 매너', '업무자동화', '준비 중']) {
    ids.set(name, insert.run(name).lastInsertRowid)
  }
  const secondVideoId = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Second tagged video', 'videos/10000000-0000-4000-8000-000000000002.mp4').lastInsertRowid
  const link = database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
  link.run(fixture.videoId, ids.get('개발'))
  link.run(secondVideoId, ids.get('개발'))
  link.run(secondVideoId, fixture.tagId)
  // Fixed expected names distinguish SQLite's existing binary order from locale or insertion order.
  const expected = ['Alpha', 'Fixture tag', 'Zulu', 'beta', 'Éclair', '개발', '기획/PM', '데이터 분석',
    '비즈니스 매너', '업무자동화', '엑셀', '준비 중'].map(name => ({ id: ids.get(name), name }))
  database.exec('PRAGMA query_only = ON')
  assertReadOnlyList(database, path, expected)
  assertReadOnlyList(database, path, expected)
})

test('committed additions, renames and deletions from another connection are reflected with original names and IDs', t => {
  const { database, context, path } = setup(t)
  const writer = context.open(path)
  database.exec('PRAGMA query_only = ON')
  assertReadOnlyList(database, path, [])
  const insert = writer.prepare('INSERT INTO tags (id, name) VALUES (?, ?)')
  insert.run(7, 'Zulu')
  assertReadOnlyList(database, path, [{ id: 7, name: 'Zulu' }])
  insert.run(Number.MAX_SAFE_INTEGER, 'Alpha')
  assertReadOnlyList(database, path, [{ id: Number.MAX_SAFE_INTEGER, name: 'Alpha' }, { id: 7, name: 'Zulu' }])
  const displayName = "  O'Reilly; SELECT tags  "
  writer.prepare('UPDATE tags SET name = ? WHERE id = ?').run(displayName, 7)
  assertReadOnlyList(database, path, [{ id: 7, name: displayName }, { id: Number.MAX_SAFE_INTEGER, name: 'Alpha' }])
  writer.prepare('DELETE FROM tags WHERE id = ?').run(Number.MAX_SAFE_INTEGER)
  assertReadOnlyList(database, path, [{ id: 7, name: displayName }])
  writer.prepare('DELETE FROM tags WHERE id = ?').run(7)
  assertReadOnlyList(database, path, [])
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('tag reads preserve caller-owned transactions and observe only their current snapshot', t => {
  const { database, context, path } = setup(t)
  // WAL is confined to the owned temporary database so another connection can commit during a read.
  assert.equal(database.prepare('PRAGMA journal_mode = WAL').get().journal_mode, 'wal')
  const writer = context.open(path)
  database.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(1, 'Zulu')
  database.exec('PRAGMA query_only = ON')
  const original = [{ id: 1, name: 'Zulu' }]
  withTransaction(database, connection => {
    assertReadOnlyList(connection, path, original)
    withTransaction(writer, writeConnection => {
      writeConnection.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(2, 'Alpha')
      writeConnection.prepare('UPDATE tags SET name = ? WHERE id = ?').run('Beta', 1)
    })
    assert.deepEqual(loadTagList(writer).map(row => ({ ...row })), [{ id: 2, name: 'Alpha' }, { id: 1, name: 'Beta' }])
    assertReadOnlyList(connection, path, original)
    assert.equal(connection.isTransaction, true)
  }, { mode: 'DEFERRED' })
  assertReadOnlyList(database, path, [{ id: 2, name: 'Alpha' }, { id: 1, name: 'Beta' }])
  assert.equal(database.isTransaction, false)
})
