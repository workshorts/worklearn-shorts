import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { removeVideoLike } from '../../src/services/video-like.js'
import { createDatabaseContext } from '../helpers/database-context.js'

const visitorA = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const visitorB = '12345678-abcd-4abc-9def-012345abcdef'
const visitorC = 'fedcba98-7654-4abc-bdef-012345abcdef'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('video-like-remove-count.db')
  context.initialize(path)
  const database = context.open(path)
  const insert = database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
  for (const id of [1, Number.MAX_SAFE_INTEGER]) {
    insert.run(id, 'Remove count target ' + id, 'videos/10000000-0000-4000-8000-000000000001.mp4')
  }
  return { context, path, database }
}

function insertLike(database, id, visitorId) {
  database.prepare('INSERT INTO video_likes (video_id, visitor_id) VALUES (?, ?)').run(id, visitorId)
}

test('removed and absent pairs return the exact remaining target count without negatives or changes to views', t => {
  const { database } = setup(t)
  const otherId = Number.MAX_SAFE_INTEGER
  for (const [id, visitor] of [[1, visitorA], [1, visitorB], [otherId, visitorA], [otherId, visitorC]]) {
    insertLike(database, id, visitor)
  }
  for (const [id, visitor] of [[1, visitorA], [1, visitorB], [1, visitorC], [otherId, visitorA]]) {
    database.prepare('INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)').run(id, visitor)
  }
  const views = database.prepare('SELECT rowid, * FROM video_views ORDER BY rowid').all()
  for (const [id, visitorId, expected] of [[1, visitorA, 1], [1, visitorA, 1], [1, visitorC, 1],
    [1, visitorB, 0], [1, visitorB, 0], [otherId, visitorA, 1], [otherId, visitorC, 0], [otherId, visitorC, 0]]) {
    const result = removeVideoLike(database, { id, visitorId })
    assert.deepEqual(result, { videoId: id, likeCount: expected, likedByMe: false })
    assert.equal(Number.isInteger(result.likeCount), true)
    assert.ok(result.likeCount >= 0)
    assert.equal(result.likeCount, database.prepare('SELECT COUNT(*) AS count FROM video_likes WHERE video_id = ?').get(id).count)
    assert.equal(database.isTransaction, false)
  }
  assert.deepEqual(database.prepare('SELECT rowid, * FROM video_views ORDER BY rowid').all(), views)
})

test('actual and no-op deletions aggregate once on the same active connection after deletion and before commit', t => {
  const { database } = setup(t)
  const id = Number.MAX_SAFE_INTEGER
  insertLike(database, id, visitorA)
  insertLike(database, id, visitorB)
  const events = []
  const exec = database.exec.bind(database)
  const prepare = database.prepare.bind(database)
  t.mock.method(database, 'exec', sql => { events.push({ kind: sql }); return exec(sql) })
  t.mock.method(database, 'prepare', sql => {
    const statement = prepare(sql)
    for (const method of ['get', 'run']) {
      const original = statement[method].bind(statement)
      t.mock.method(statement, method, (...params) => {
        const event = { kind: method, sql, params, active: database.isTransaction }
        events.push(event)
        const result = original(...params)
        if (method === 'run') event.changes = result.changes
        return result
      })
    }
    return statement
  })
  for (const changes of [1, 0]) {
    events.length = 0
    assert.deepEqual(removeVideoLike(database, { id, visitorId: visitorA }),
      { videoId: id, likeCount: 1, likedByMe: false })
    const deletion = events.find(event => event.kind === 'run')
    const counts = events.filter(event => event.sql?.startsWith('SELECT COUNT(*)'))
    const deleteIndex = events.indexOf(deletion)
    const countIndex = events.indexOf(counts[0])
    const commitIndex = events.findIndex(event => event.kind === 'COMMIT')
    assert.equal(events[0].kind, 'BEGIN IMMEDIATE')
    assert.equal(counts.length, 1)
    assert.ok(deleteIndex >= 0 && countIndex > deleteIndex && commitIndex > countIndex)
    assert.equal(deletion.changes, changes)
    assert.deepEqual(deletion.params, [id, visitorA])
    assert.deepEqual(counts[0].params, [id])
    assert.ok(events.filter(event => event.sql).every(event => event.active))
    assert.equal(database.isTransaction, false)
  }
})

test('aggregate preparation and execution errors restore deleted rows and preserve absent pairs before recovery', t => {
  const { database, path } = setup(t)
  insertLike(database, 1, visitorA)
  const snapshot = () => ({
    rows: database.prepare('SELECT rowid, * FROM video_likes ORDER BY rowid').all(),
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  })
  const before = snapshot()
  for (const stage of ['prepare', 'get']) {
    for (const visitorId of [visitorA, visitorB]) {
      const failure = new Error('Injected remove aggregate failure at ' + stage)
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
        assert.throws(() => removeVideoLike(database, { id: 1, visitorId }), error => error === failure)
      } finally { fault.mock.restore() }
      assert.equal(failures, 1)
      assert.equal(database.isTransaction, false)
      assert.equal(database.isOpen, true)
      assert.deepEqual(snapshot(), before)
    }
  }
  assert.deepEqual(removeVideoLike(database, { id: 1, visitorId: visitorA }),
    { videoId: 1, likeCount: 0, likedByMe: false })
  assert.deepEqual(removeVideoLike(database, { id: 1, visitorId: visitorB }),
    { videoId: 1, likeCount: 0, likedByMe: false })
})

test('a removal retains its own aggregate when another connection removes a different visitor immediately after commit', t => {
  const { context, path, database } = setup(t)
  insertLike(database, 1, visitorA)
  insertLike(database, 1, visitorB)
  const other = context.open(path)
  const exec = database.exec.bind(database)
  let later
  const observed = t.mock.method(database, 'exec', sql => {
    const result = exec(sql)
    if (sql === 'COMMIT') later = removeVideoLike(other, { id: 1, visitorId: visitorB })
    return result
  })
  let first
  try { first = removeVideoLike(database, { id: 1, visitorId: visitorA }) }
  finally { observed.mock.restore() }
  assert.deepEqual(first, { videoId: 1, likeCount: 1, likedByMe: false })
  assert.deepEqual(later, { videoId: 1, likeCount: 0, likedByMe: false })
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_likes').get().count, 0)
  assert.deepEqual(removeVideoLike(database, { id: 1, visitorId: visitorA }),
    { videoId: 1, likeCount: 0, likedByMe: false })
  assert.equal(database.isTransaction, false)
  assert.equal(other.isTransaction, false)
})
