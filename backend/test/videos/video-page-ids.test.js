import assert from 'node:assert/strict'
import test from 'node:test'
import { loadVideoPageIds } from '../../src/db/video-page-queries.js'
import { withTransaction } from '../../src/db/transaction.js'
import { createDatabaseContext } from '../helpers/database-context.js'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('video-page-ids.db')
  context.initialize(path)
  return context.open(path)
}

function insertVideos(database, ids) {
  const insert = database.prepare('INSERT INTO videos (id, title, video_path, created_at) VALUES (?, ?, ?, ?)')
  for (const [index, id] of ids.entries()) {
    insert.run(id, 'Page video ' + id, 'videos/10000000-0000-4000-8000-000000000001.mp4',
      `${2000 + index}-01-01T00:00:00.000Z`)
  }
}

test('page IDs follow descending primary keys across sparse pages without repeats or missing rows', t => {
  const database = setup(t)
  insertVideos(database, [11, 2, 101, 57, 8, 33, 3])
  const pages = [1, 2, 3, 4].map(page => loadVideoPageIds(database, { page, limit: 3 }))
  assert.deepEqual(pages, [[101, 57, 33], [11, 8, 3], [2], []])
  assert.equal(new Set(pages.flat()).size, 7)

  database.prepare('DELETE FROM videos WHERE id = ?').run(33)
  assert.deepEqual(loadVideoPageIds(database, { page: 1, limit: 3 }), [101, 57, 11])
  assert.deepEqual(loadVideoPageIds(database, { page: 2, limit: 3 }), [8, 3, 2])
})

test('page IDs handle empty data, minimum and maximum page sizes, and pages beyond the end', t => {
  const database = setup(t)
  assert.deepEqual(loadVideoPageIds(database, { page: 1, limit: 20 }), [])
  insertVideos(database, Array.from({ length: 51 }, (_, index) => index + 1))
  assert.deepEqual(loadVideoPageIds(database, { page: 1, limit: 1 }), [51])
  assert.deepEqual(loadVideoPageIds(database, { page: 51, limit: 1 }), [1])
  assert.deepEqual(loadVideoPageIds(database, { page: 52, limit: 1 }), [])
  assert.deepEqual(loadVideoPageIds(database, { page: 1, limit: 50 }),
    Array.from({ length: 50 }, (_, index) => 51 - index))
  assert.deepEqual(loadVideoPageIds(database, { page: 2, limit: 50 }), [1])
  assert.deepEqual(loadVideoPageIds(database, { page: 3, limit: 50 }), [])
})

test('page selection preserves safe boundary IDs as numbers and orders them independently of creation time', t => {
  const database = setup(t)
  insertVideos(database, [Number.MAX_SAFE_INTEGER, 1])
  assert.deepEqual(loadVideoPageIds(database, { page: 1, limit: 1 }), [Number.MAX_SAFE_INTEGER])
  assert.deepEqual(loadVideoPageIds(database, { page: 2, limit: 1 }), [1])
})

test('large valid page values bind exact offsets instead of rounded JavaScript products', t => {
  const database = setup(t)
  insertVideos(database, [1])
  const bindings = []
  const prepare = database.prepare.bind(database)
  t.mock.method(database, 'prepare', sql => {
    const statement = prepare(sql)
    const all = statement.all.bind(statement)
    t.mock.method(statement, 'all', (...params) => {
      bindings.push(params)
      return all(...params)
    })
    return statement
  })

  const cases = [
    { page: 1, limit: 20, offset: 0n, expected: [1] },
    { page: 2, limit: 3, offset: 3n, expected: [] },
    { page: Number.MAX_SAFE_INTEGER, limit: 1, offset: 9007199254740990n, expected: [] },
    { page: 183820392953900, limit: 49, offset: 9007199254741051n, expected: [] },
    { page: Number.MAX_SAFE_INTEGER, limit: 49, offset: 441352763482308510n, expected: [] },
    { page: Number.MAX_SAFE_INTEGER, limit: 50, offset: 450359962737049500n, expected: [] },
  ]
  for (const { page, limit, expected } of cases) {
    assert.deepEqual(loadVideoPageIds(database, { page, limit }), expected)
  }
  assert.deepEqual(bindings, cases.map(({ limit, offset }) => [limit, offset]))
})

test('page selection works inside the caller read snapshot with writes disabled without ending the transaction', t => {
  const database = setup(t)
  insertVideos(database, [3, 1, 2])
  database.exec('PRAGMA query_only = ON')
  try {
    const result = withTransaction(database, connection => {
      assert.equal(connection.isTransaction, true)
      const ids = loadVideoPageIds(connection, { page: 1, limit: 2 })
      assert.equal(connection.isTransaction, true)
      assert.equal(connection.isOpen, true)
      return ids
    }, { mode: 'DEFERRED' })
    assert.deepEqual(result, [3, 2])
    assert.equal(database.isTransaction, false)
    assert.equal(database.isOpen, true)
  } finally {
    database.exec('PRAGMA query_only = OFF')
  }
})
