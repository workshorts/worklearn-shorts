import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { withTransaction } from '../../src/db/transaction.js'
import { addVideoLike } from '../../src/services/video-like.js'
import { createDatabaseContext } from '../helpers/database-context.js'

const visitorA = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const visitorB = '12345678-abcd-4abc-9def-012345abcdef'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('video-like-count.db')
  context.initialize(path)
  const database = context.open(path)
  const insert = database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
  for (const id of [1, Number.MAX_SAFE_INTEGER]) {
    insert.run(id, 'Like count target ' + id, 'videos/10000000-0000-4000-8000-000000000001.mp4')
  }
  return { context, path, database }
}

test('like counts include each target visitor after insertion or duplication without counting views or another video', t => {
  const { database } = setup(t)
  const otherId = Number.MAX_SAFE_INTEGER
  withTransaction(database, connection => {
    for (const [table, pairs] of [['video_likes', [[1, 2], [otherId, 3]]],
      ['video_views', [[1, 6], [otherId, 1]]]]) {
      const insert = connection.prepare(`INSERT INTO ${table} (video_id, visitor_id) VALUES (?, ?)`)
      for (const [id, count] of pairs) {
        for (let index = 1; index <= count; index += 1) {
          insert.run(id, '00000000-0000-4000-8000-' + String(index).padStart(12, '0'))
        }
      }
    }
  })
  const views = database.prepare('SELECT rowid, * FROM video_views ORDER BY rowid').all()
  for (const [id, visitorId, expected] of [[1, visitorA, 3], [1, visitorA, 3],
    [1, visitorB, 4], [1, visitorA, 4], [otherId, visitorA, 4], [otherId, visitorB, 5], [otherId, visitorA, 5]]) {
    const result = addVideoLike(database, { id, visitorId })
    assert.deepEqual(result, { videoId: id, likeCount: expected, likedByMe: true })
    assert.equal(typeof result.likeCount, 'number')
    assert.equal(result.likeCount, database.prepare('SELECT COUNT(*) AS count FROM video_likes WHERE video_id = ?').get(id).count)
    assert.equal(database.isTransaction, false)
  }
  assert.deepEqual(database.prepare('SELECT rowid, * FROM video_views ORDER BY rowid').all(), views)
})

test('new and duplicate likes aggregate on the same active connection after insertion and before commit with a bound ID', t => {
  const { database } = setup(t)
  const id = Number.MAX_SAFE_INTEGER
  const events = []
  const exec = database.exec.bind(database)
  const prepare = database.prepare.bind(database)
  t.mock.method(database, 'exec', sql => { events.push({ kind: sql }); return exec(sql) })
  t.mock.method(database, 'prepare', sql => {
    const statement = prepare(sql)
    for (const method of ['get', 'run']) {
      const original = statement[method].bind(statement)
      t.mock.method(statement, method, (...params) => {
        events.push({ kind: method, sql, params, active: database.isTransaction })
        return original(...params)
      })
    }
    return statement
  })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    events.length = 0
    assert.deepEqual(addVideoLike(database, { id, visitorId: visitorA }),
      { videoId: id, likeCount: 1, likedByMe: true })
    const insertIndex = events.findIndex(event => event.kind === 'run')
    const counts = events.filter(event => event.sql?.startsWith('SELECT COUNT(*)'))
    const countIndex = events.indexOf(counts[0])
    const commitIndex = events.findIndex(event => event.kind === 'COMMIT')
    assert.equal(events[0].kind, 'BEGIN IMMEDIATE')
    assert.equal(counts.length, 1)
    assert.ok(insertIndex >= 0 && countIndex > insertIndex && commitIndex > countIndex)
    assert.deepEqual(counts[0].params, [id])
    assert.ok(events.filter(event => event.sql).every(event => event.active))
    assert.equal(database.isTransaction, false)
  }
})

test('aggregate preparation and execution failures roll back new likes and preserve duplicates before recovery', t => {
  const { database, path } = setup(t)
  assert.deepEqual(addVideoLike(database, { id: 1, visitorId: visitorA }),
    { videoId: 1, likeCount: 1, likedByMe: true })
  const snapshot = () => ({
    rows: database.prepare('SELECT rowid, * FROM video_likes ORDER BY rowid').all(),
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  })
  const before = snapshot()
  for (const stage of ['prepare', 'get']) {
    for (const visitorId of [visitorB, visitorA]) {
      const failure = new Error('Injected like aggregate failure at ' + stage)
      const prepare = database.prepare.bind(database)
      let failures = 0
      const fault = t.mock.method(database, 'prepare', sql => {
        if (sql.startsWith('SELECT COUNT(*)')) {
          if (stage === 'prepare') { failures += 1; throw failure }
          const statement = prepare(sql)
          statement.get = () => { failures += 1; throw failure }
          return statement
        }
        return prepare(sql)
      })
      try {
        assert.throws(() => addVideoLike(database, { id: 1, visitorId }), error => error === failure)
      } finally { fault.mock.restore() }
      assert.equal(failures, 1)
      assert.equal(database.isTransaction, false)
      assert.equal(database.isOpen, true)
      assert.deepEqual(snapshot(), before)
    }
  }
  assert.deepEqual(addVideoLike(database, { id: 1, visitorId: visitorB }),
    { videoId: 1, likeCount: 2, likedByMe: true })
  assert.deepEqual(addVideoLike(database, { id: 1, visitorId: visitorA }),
    { videoId: 1, likeCount: 2, likedByMe: true })
})

test('a committed result retains its own aggregate when another connection adds a visitor immediately after commit', t => {
  const { context, path, database } = setup(t)
  const other = context.open(path)
  const exec = database.exec.bind(database)
  let later
  const observed = t.mock.method(database, 'exec', sql => {
    const result = exec(sql)
    if (sql === 'COMMIT') later = addVideoLike(other, { id: 1, visitorId: visitorB })
    return result
  })
  let first
  try { first = addVideoLike(database, { id: 1, visitorId: visitorA }) }
  finally { observed.mock.restore() }
  assert.deepEqual(first, { videoId: 1, likeCount: 1, likedByMe: true })
  assert.deepEqual(later, { videoId: 1, likeCount: 2, likedByMe: true })
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_likes').get().count, 2)
  assert.deepEqual(addVideoLike(database, { id: 1, visitorId: visitorA }),
    { videoId: 1, likeCount: 2, likedByMe: true })
  assert.equal(database.isTransaction, false)
  assert.equal(other.isTransaction, false)
})
