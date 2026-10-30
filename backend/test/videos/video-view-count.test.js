import assert from 'node:assert/strict'
import test from 'node:test'
import { withTransaction } from '../../src/db/transaction.js'
import { recordVideoView } from '../../src/services/video-view.js'
import { createDatabaseContext } from '../helpers/database-context.js'

const visitorA = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const visitorB = '12345678-abcd-4abc-9def-012345abcdef'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('video-view-count.db')
  context.initialize(path)
  const database = context.open(path)
  const insert = database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
  for (const id of [1, 2]) insert.run(id, 'Aggregate target ' + id, 'videos/10000000-0000-4000-8000-000000000001.mp4')
  return { context, path, database }
}

test('the returned count includes all target visitors after insert or duplicate without including another video', t => {
  const { database } = setup(t)
  withTransaction(database, connection => {
    const insert = connection.prepare('INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)')
    for (const [id, count] of [[1, 2], [2, 3]]) {
      for (let index = 1; index <= count; index += 1) {
        insert.run(id, '00000000-0000-4000-8000-' + String(index).padStart(12, '0'))
      }
    }
  })
  for (const [id, visitorId, viewCount, counted] of [[1, visitorA, 3, true], [1, visitorA, 3, false],
    [1, visitorB, 4, true], [1, visitorA, 4, false], [2, visitorA, 4, true]]) {
    const result = recordVideoView(database, { id, visitorId })
    assert.deepEqual(result, { videoId: id, viewCount, counted })
    assert.equal(result.viewCount, database.prepare('SELECT COUNT(*) AS count FROM video_views WHERE video_id = ?').get(id).count)
  }
})

test('the aggregate uses the same active connection after insertion and before commit with the target ID bound', t => {
  const { database } = setup(t)
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
  assert.deepEqual(recordVideoView(database, { id: 1, visitorId: visitorA }),
    { videoId: 1, viewCount: 1, counted: true })
  const insertIndex = events.findIndex(event => event.kind === 'run')
  const countIndex = events.findIndex(event => event.sql?.startsWith('SELECT COUNT(*)'))
  const commitIndex = events.findIndex(event => event.kind === 'COMMIT')
  assert.equal(events[0].kind, 'BEGIN IMMEDIATE')
  assert.ok(insertIndex >= 0 && countIndex > insertIndex && commitIndex > countIndex)
  assert.deepEqual(events[countIndex].params, [1])
  assert.ok(events.filter(event => event.sql).every(event => event.active))
  assert.equal(database.isTransaction, false)
})

test('an aggregation failure rolls back the newly inserted view and a subsequent retry is new', t => {
  const { database } = setup(t)
  const failure = new Error('Injected view aggregation failure')
  const prepare = database.prepare.bind(database)
  const fault = t.mock.method(database, 'prepare', sql => {
    if (sql.startsWith('SELECT COUNT(*)')) throw failure
    return prepare(sql)
  })
  assert.throws(() => recordVideoView(database, { id: 1, visitorId: visitorA }), error => error === failure)
  fault.mock.restore()
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_views').get().count, 0)
  assert.equal(database.isTransaction, false)
  assert.equal(database.isOpen, true)
  assert.deepEqual(recordVideoView(database, { id: 1, visitorId: visitorA }),
    { videoId: 1, viewCount: 1, counted: true })
})

test('a response retains its pre-commit aggregate even if another connection records a visitor immediately after commit', t => {
  const { context, path, database } = setup(t)
  const other = context.open(path)
  const exec = database.exec.bind(database)
  let later
  const observed = t.mock.method(database, 'exec', sql => {
    const result = exec(sql)
    if (sql === 'COMMIT') later = recordVideoView(other, { id: 1, visitorId: visitorB })
    return result
  })
  const first = recordVideoView(database, { id: 1, visitorId: visitorA })
  observed.mock.restore()
  assert.deepEqual(first, { videoId: 1, viewCount: 1, counted: true })
  assert.deepEqual(later, { videoId: 1, viewCount: 2, counted: true })
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_views').get().count, 2)
  assert.deepEqual(recordVideoView(database, { id: 1, visitorId: visitorA }),
    { videoId: 1, viewCount: 2, counted: false })
})
