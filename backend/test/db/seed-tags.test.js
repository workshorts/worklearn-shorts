import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { closeDatabase } from '../../src/db/connection.js'
import { insertSeedTags, SEED_TAG_NAMES } from '../../src/db/seed-tags.js'
import { withTransaction } from '../../src/db/transaction.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('seed-tags.db')
  context.initialize(path)
  return { context, path, database: context.open(path) }
}

function snapshot(database) {
  return {
    tags: database.prepare('SELECT * FROM tags ORDER BY id').all(),
    links: database.prepare('SELECT * FROM video_tags ORDER BY video_id, tag_id').all(),
    sequence: database.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()
  }
}

function seed(database, names) {
  return withTransaction(database, connection => insertSeedTags(connection, names))
}

test('default seed tags persist the seven baseline names and return their actual IDs', t => {
  const { context, path, database } = setup(t)
  const expected = ['엑셀', '개발', '업무자동화', '비즈니스 매너', '기획/PM', '데이터 분석', '준비 중']
  assert.deepEqual(SEED_TAG_NAMES, expected)
  assert.equal(Object.isFrozen(SEED_TAG_NAMES), true)
  const tags = withTransaction(database, connection => {
    const result = insertSeedTags(connection)
    assert.equal(connection.isTransaction, true)
    return result
  })
  assert.deepEqual(tags.map(tag => tag.name), expected)
  assert.deepEqual(tags, database.prepare('SELECT id, name FROM tags ORDER BY id').all().map(row => ({ ...row })))
  for (const table of ['admins', 'videos', 'video_tags', 'courses', 'course_videos',
    'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options']) {
    assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0)
  }
  const before = snapshot(database)
  closeDatabase(database)
  assert.deepEqual(snapshot(context.open(path)), before)
})

test('repeated seed tags preserve rows, links, sequences and database bytes', t => {
  const { context, path, database } = setup(t)
  insertMinimalFixture(database)
  const tags = seed(database)
  const before = snapshot(database)
  closeDatabase(database)
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
  const reopened = context.open(path)
  assert.deepEqual(seed(reopened), tags)
  assert.deepEqual(seed(reopened, SEED_TAG_NAMES.map(name => `  ${name.toUpperCase()}\u3000`)), tags)
  assert.deepEqual(snapshot(reopened), before)
  closeDatabase(reopened)
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), hash)
})

test('seed tags reuse normalized existing names and IDs while preserving their links and display spelling', t => {
  const { database } = setup(t)
  const { videoId } = insertMinimalFixture(database)
  database.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(41, ' \tÉCLAIR\u00a0')
  database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(videoId, 41)
  const before = snapshot(database)
  const tags = seed(database, ['\ufefféclair\u3000', ' Éclair ', ' 노드JS ', '노드js', 'İ', 'i\u0307'])
  assert.deepEqual(tags, [{ id: 41, name: ' \tÉCLAIR\u00a0' }, { id: 42, name: '노드JS' }, { id: 43, name: 'İ' }])
  assert.deepEqual(snapshot(database).links, before.links)
  assert.deepEqual(snapshot(database).tags.slice(0, before.tags.length), before.tags)
  assert.equal(database.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get('tags').seq, 43)
})

test('seed tags preserve additional administrator tags and impose no four-tag or seven-tag limit', t => {
  const { database } = setup(t)
  const extra = Array.from({ length: 12 }, (_, index) => `Extra tag ${index + 1}`)
  const original = seed(database, extra)
  const baseline = seed(database)
  assert.equal(baseline.length, 7)
  assert.equal(database.prepare('SELECT count(*) AS count FROM tags').get().count, 19)
  assert.deepEqual(seed(database, extra), original)
  assert.deepEqual(snapshot(database).tags.slice(0, 12).map(row => ({ ...row })), original)
})

test('seed tag normalization preserves internal spaces and distinct Unicode forms and binds SQL-like names', t => {
  const { database } = setup(t)
  const names = [' Node JS ', 'Node  JS', 'Éclair', 'E\u0301clair', 'Straße', 'STRASSE', 'Ｎｏｄｅ', 'Node', "' OR 1=1 --"]
  const tags = seed(database, names)
  assert.deepEqual(tags.map(tag => tag.name), names.map(name => name.trim()))
  assert.equal(new Set(tags.map(tag => tag.id)).size, names.length)
  assert.deepEqual(seed(database, names), tags)
})

test('seed tags validate the entire batch before writing and reject invalid names even after a duplicate', t => {
  const { database } = setup(t)
  seed(database, ['Existing'])
  const before = snapshot(database)
  const invalid = [null, 'tag', {}, new Set(['tag']), [undefined], Array(1),
    ['New', ' existing ', null], ['New', ''], ['New', '\u00a0\t\u3000'],
    ['New', 'x'.repeat(31)], ['New', 'bad\0tag'], ['New', 7]]
  withTransaction(database, connection => {
    for (const names of invalid) {
      assert.throws(() => insertSeedTags(connection, names), { name: 'TypeError' })
      assert.deepEqual(snapshot(connection), before)
      assert.equal(connection.isTransaction, true)
    }
  })
  assert.deepEqual(seed(database, ['  A  ', ` ${'B'.repeat(30)} `]).map(tag => tag.name), ['A', 'B'.repeat(30)])
})

test('an empty seed tag batch is a no-op and does not mutate the input array', t => {
  const { database } = setup(t)
  const before = snapshot(database)
  assert.deepEqual(seed(database, []), [])
  assert.deepEqual(snapshot(database), before)
  const names = Object.freeze([' Mixed CASE ', 'mixed case'])
  assert.equal(seed(database, names).length, 1)
  assert.deepEqual(names, [' Mixed CASE ', 'mixed case'])
})

test('seed tags recheck names committed by another connection and return the stored ID', t => {
  const { context, path, database } = setup(t)
  const other = context.open(path)
  const tags = seed(other, [' Existing '])
  const before = snapshot(other)
  assert.deepEqual(seed(database, ['EXISTING']), tags)
  assert.deepEqual(snapshot(database), before)
})

test('seed tags require an open connection and an active caller transaction', t => {
  const { database } = setup(t)
  const before = snapshot(database)
  assert.throws(() => insertSeedTags(database), { message: 'Seed tag insertion requires an active transaction.' })
  assert.deepEqual(snapshot(database), before)
  closeDatabase(database)
  assert.throws(() => insertSeedTags(database), { message: 'Database connection is closed.' })
  assert.equal(database.isOpen, false)
})

test('seed tags leave rollback to the caller and allow reuse after a rolled-back batch', t => {
  const { database } = setup(t)
  seed(database, ['Existing'])
  const before = snapshot(database)
  const failure = new Error('Expected tag seed rollback')
  assert.throws(() => withTransaction(database, connection => {
    insertSeedTags(connection, ['Existing', 'New tag', 'Another tag'])
    assert.equal(connection.isTransaction, true)
    throw failure
  }), error => error === failure)
  assert.deepEqual(snapshot(database), before)
  assert.equal(seed(database, ['New tag']).length, 1)
})

test('seed tags propagate storage errors and retain no partial data after caller rollback', t => {
  const { database } = setup(t)
  const before = snapshot(database)
  assert.throws(() => withTransaction(database, connection => {
    insertSeedTags(connection, ['First tag'])
    connection.exec('PRAGMA query_only = ON')
    insertSeedTags(connection, ['Second tag'])
  }), { code: 'ERR_SQLITE_ERROR', errcode: 8 })
  assert.deepEqual(snapshot(database), before)
  assert.equal(database.isOpen, true)
  assert.equal(database.isTransaction, false)
  database.exec('PRAGMA query_only = OFF')
  assert.equal(seed(database).length, 7)
})
