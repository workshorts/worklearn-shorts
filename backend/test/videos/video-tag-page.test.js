import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadVideoPageIds } from '../../src/db/video-page-queries.js'
import { withTransaction } from '../../src/db/transaction.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('video-tag-page.db')
  context.initialize(path)
  const database = context.open(path)
  const fixture = insertMinimalFixture(database)
  const otherTagId = database.prepare('INSERT INTO tags (name) VALUES (?)').run('Other tag').lastInsertRowid
  const unusedTagId = database.prepare('INSERT INTO tags (name) VALUES (?)').run('Unused tag').lastInsertRowid
  const insert = database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
  for (const id of [11, 3, Number.MAX_SAFE_INTEGER, 2, 50, 4, 7]) {
    insert.run(id, 'Tag page video ' + id, 'videos/10000000-0000-4000-8000-000000000001.mp4')
  }
  const link = database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
  for (const id of [3, 7, 50]) link.run(id, fixture.tagId)
  for (const id of [2, 3, 7, 11, 50, Number.MAX_SAFE_INTEGER]) link.run(id, otherTagId)
  return { context, path, database, ...fixture, otherTagId, unusedTagId }
}

function snapshot(database, path) {
  return {
    rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }
}

function assertPage(database, path, options, expected) {
  const before = snapshot(database, path)
  const transaction = database.isTransaction
  assert.deepEqual(loadVideoPageIds(database, options), expected)
  assert.deepEqual(snapshot(database, path), before)
  assert.equal(database.isTransaction, transaction)
  assert.equal(database.isOpen, true)
}

test('tag membership is applied before paging and multiple tag links cannot duplicate or displace matching videos', t => {
  const { database, path, tagId } = setup(t)
  database.exec('PRAGMA query_only = ON')
  const pages = [[50, 7], [3, 1], []]
  for (const [index, expected] of pages.entries()) {
    assertPage(database, path, { tagId, page: index + 1, limit: 2 }, expected)
  }
  assert.equal(new Set(pages.flat()).size, 4)
  assertPage(database, path, { tagId, page: 1, limit: 50 }, [50, 7, 3, 1])
  for (const options of [{ page: 1, limit: 3 }, { page: 1, limit: 3, tagId: null }]) {
    assertPage(database, path, options, [Number.MAX_SAFE_INTEGER, 50, 11])
  }
})

test('unused or missing tags and pages beyond the filtered end return empty arrays while other tags remain independent', t => {
  const { database, path, tagId, otherTagId, unusedTagId } = setup(t)
  database.exec('PRAGMA query_only = ON')
  for (const selected of [unusedTagId, Number.MAX_SAFE_INTEGER]) {
    assertPage(database, path, { tagId: selected, page: 1, limit: 20 }, [])
  }
  assertPage(database, path, { tagId, page: 5, limit: 1 }, [])
  assertPage(database, path, { tagId, page: Number.MAX_SAFE_INTEGER, limit: 50 }, [])
  assertPage(database, path, { tagId: otherTagId, page: 1, limit: 50 }, [Number.MAX_SAFE_INTEGER, 50, 11, 7, 3, 2])
})

test('filtered paging binds the safe tag boundary and exact large offsets without interpolating values into SQL', t => {
  const { database, path } = setup(t)
  const tagId = Number.MAX_SAFE_INTEGER
  database.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(tagId, 'Boundary tag')
  database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(Number.MAX_SAFE_INTEGER, tagId)
  const calls = []
  const prepare = database.prepare.bind(database)
  t.mock.method(database, 'prepare', sql => {
    const statement = prepare(sql)
    if (sql.includes('LIMIT ? OFFSET ?')) {
      const all = statement.all.bind(statement)
      t.mock.method(statement, 'all', (...params) => {
        calls.push({ sql, params })
        return all(...params)
      })
    }
    return statement
  })
  assertPage(database, path, { tagId, page: 1, limit: 1 }, [Number.MAX_SAFE_INTEGER])
  assertPage(database, path, { tagId, page: 2, limit: 1 }, [])
  assertPage(database, path, { tagId, page: 183820392953900, limit: 49 }, [])
  assertPage(database, path, { tagId, page: Number.MAX_SAFE_INTEGER, limit: 50 }, [])
  assert.deepEqual(calls.map(call => call.params), [
    [tagId, 1, 0n], [tagId, 1, 1n], [tagId, 49, 9007199254741051n], [tagId, 50, 450359962737049500n],
  ])
  for (const { sql } of calls) assert.equal(sql.includes(String(tagId)), false)
})

test('filtered page membership shares the caller snapshot when another connection commits tag link changes', t => {
  const { database, context, path, tagId } = setup(t)
  // WAL is confined to the owned temporary database to allow a writer during the read snapshot.
  assert.equal(database.prepare('PRAGMA journal_mode = WAL').get().journal_mode, 'wal')
  const writer = context.open(path)
  database.exec('PRAGMA query_only = ON')
  withTransaction(database, connection => {
    assertPage(connection, path, { tagId, page: 1, limit: 2 }, [50, 7])
    withTransaction(writer, writeConnection => {
      writeConnection.prepare('DELETE FROM video_tags WHERE video_id = ? AND tag_id = ?').run(3, tagId)
      writeConnection.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(Number.MAX_SAFE_INTEGER, tagId)
    })
    assertPage(connection, path, { tagId, page: 1, limit: 2 }, [50, 7])
    assertPage(connection, path, { tagId, page: 2, limit: 2 }, [3, 1])
    assert.equal(connection.isTransaction, true)
  }, { mode: 'DEFERRED' })
  assertPage(database, path, { tagId, page: 1, limit: 2 }, [Number.MAX_SAFE_INTEGER, 50])
  assertPage(database, path, { tagId, page: 2, limit: 2 }, [7, 1])
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})
