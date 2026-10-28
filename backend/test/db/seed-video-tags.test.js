import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { closeDatabase } from '../../src/db/connection.js'
import { insertSeedTags } from '../../src/db/seed-tags.js'
import { insertSeedVideoTags, SEED_VIDEO_TAGS } from '../../src/db/seed-video-tags.js'
import { insertSeedVideos, SEED_VIDEOS } from '../../src/db/seed-videos.js'
import { withTransaction } from '../../src/db/transaction.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('seed-video-tags.db')
  context.initialize(path)
  return { context, path, database: context.open(path) }
}

function parents(database) {
  return withTransaction(database, connection => ({
    videos: insertSeedVideos(connection), tags: insertSeedTags(connection)
  }))
}

function snapshot(database) {
  return Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}

function seed(database, links) {
  return withTransaction(database, connection => insertSeedVideoTags(connection, links))
}

function storedLinks(database) {
  return database.prepare(`SELECT v.video_path AS videoPath, t.name AS tagName
    FROM video_tags AS vt JOIN videos AS v ON v.id = vt.video_id JOIN tags AS t ON t.id = vt.tag_id
    ORDER BY v.id, t.id`).all().map(row => ({ ...row }))
}

test('default seed video tag manifest contains the ten baseline pairs without a V05 or preparation tag link', () => {
  const expected = [
    [0, '엑셀'], [0, '업무자동화'], [1, '개발'], [2, '개발'], [2, '업무자동화'],
    [3, '비즈니스 매너'], [5, '기획/PM'], [6, '엑셀'], [6, '데이터 분석'], [7, '비즈니스 매너']
  ].map(([index, tagName]) => ({ videoPath: SEED_VIDEOS[index].videoPath, tagName }))
  assert.deepEqual(SEED_VIDEO_TAGS, expected)
  assert.equal(Object.isFrozen(SEED_VIDEO_TAGS), true)
  assert.ok(SEED_VIDEO_TAGS.every(Object.isFrozen))
})

test('seed video tag links resolve actual IDs in the parent transaction and persist after reopening', t => {
  const { context, path, database } = setup(t)
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(41, 'Existing video', 'existing.mp4')
  database.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(73, 'Existing tag')
  const result = withTransaction(database, connection => {
    insertSeedVideos(connection)
    insertSeedTags(connection)
    const pairs = insertSeedVideoTags(connection)
    assert.equal(connection.isTransaction, true)
    return pairs
  })
  assert.equal(result.length, 10)
  assert.ok(result.every(({ videoId, tagId }) => videoId > 41 && tagId > 73))
  assert.deepEqual(storedLinks(database), SEED_VIDEO_TAGS)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
  const before = snapshot(database)
  closeDatabase(database)
  assert.deepEqual(snapshot(context.open(path)), before)
})

test('repeated link seeding adds only missing pairs and preserves extra links, all data and file bytes', t => {
  const { context, path, database } = setup(t)
  const { videoId, tagId } = insertMinimalFixture(database)
  const { videos, tags } = parents(database)
  const insert = database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
  insert.run(videos[0].id, tags[0].id)
  insert.run(videos[0].id, tagId)
  insert.run(videoId, tags[0].id)
  insert.run(videos[4].id, tags[6].id)
  const before = snapshot(database)
  const result = seed(database)
  const after = snapshot(database)
  assert.equal(after.video_tags.length, before.video_tags.length + 9)
  for (const original of before.video_tags) assert.ok(after.video_tags.some(row => row.video_id === original.video_id && row.tag_id === original.tag_id))
  for (const table of tables.filter(table => table !== 'video_tags')) assert.deepEqual(after[table], before[table])
  closeDatabase(database)
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
  const reopened = context.open(path)
  assert.deepEqual(seed(reopened), result)
  assert.deepEqual(snapshot(reopened), after)
  closeDatabase(reopened)
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), hash)
})

test('a missing video in the last link fails before any pair is inserted without creating parents', t => {
  const { database } = setup(t)
  const { videos } = parents(database)
  database.prepare('DELETE FROM videos WHERE id = ?').run(videos[7].id)
  const before = snapshot(database)
  withTransaction(database, connection => {
    assert.throws(() => insertSeedVideoTags(connection), { code: 'MISSING_SEED_VIDEO' })
    assert.deepEqual(snapshot(connection), before)
    assert.equal(connection.isTransaction, true)
  })
})

test('a missing tag in a later link fails before writes without recreating the tag', t => {
  const { database } = setup(t)
  const { tags } = parents(database)
  database.prepare('DELETE FROM tags WHERE id = ?').run(tags[5].id)
  const before = snapshot(database)
  withTransaction(database, connection => {
    assert.throws(() => insertSeedVideoTags(connection), { code: 'MISSING_SEED_TAG' })
    assert.deepEqual(snapshot(connection), before)
  })
})

test('an ambiguous video path in the last link fails before any pair is inserted', t => {
  const { database } = setup(t)
  parents(database)
  database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)').run('Duplicate video', SEED_VIDEOS[7].videoPath)
  const before = snapshot(database)
  withTransaction(database, connection => {
    assert.throws(() => insertSeedVideoTags(connection), { code: 'AMBIGUOUS_SEED_VIDEO' })
    assert.deepEqual(snapshot(connection), before)
  })
})

test('link seeding resolves normalized Unicode tag names and deduplicates equivalent input pairs', t => {
  const { database } = setup(t)
  parents(database)
  const names = [' \tÉCLAIR\u00a0', 'İ', 'E\u0301clair', 'Node JS', 'Node  JS']
  const insert = database.prepare('INSERT INTO tags (name) VALUES (?)')
  for (const name of names) insert.run(name)
  const before = snapshot(database)
  const variants = ['\ufefféclair\u3000', 'ÉCLAIR', 'i\u0307', 'İ', 'E\u0301CLAIR', 'node js', 'node  js']
  const result = seed(database, variants.map(tagName => ({ videoPath: SEED_VIDEOS[0].videoPath, tagName })))
  assert.equal(result.length, 5)
  assert.equal(new Set(result.map(pair => pair.tagId)).size, 5)
  assert.deepEqual(storedLinks(database).map(link => link.tagName), names)
  for (const table of tables.filter(table => table !== 'video_tags')) assert.deepEqual(snapshot(database)[table], before[table])
})

test('link lookup uses exact video paths and binds SQL-like tag names literally', t => {
  const { database } = setup(t)
  const { videos } = parents(database)
  const tagName = "' OR 1=1 --"
  const tagId = database.prepare('INSERT INTO tags (name) VALUES (?)').run(tagName).lastInsertRowid
  const upperPath = SEED_VIDEOS[0].videoPath.replace('.mp4', '.MP4')
  const upperId = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)').run('Uppercase video', upperPath).lastInsertRowid
  // A single manifest cannot share paths that differ only in case on Windows.
  const result = [
    ...seed(database, [{ videoPath: upperPath, tagName }]),
    ...seed(database, [{ videoPath: SEED_VIDEOS[0].videoPath, tagName }])
  ]
  assert.deepEqual(result, [{ videoId: upperId, tagId }, { videoId: videos[0].id, tagId }])
  assert.equal(database.prepare('SELECT count(*) AS count FROM video_tags').get().count, 2)
})

test('link seeding validates all inputs before writes and leaves frozen input and empty batches unchanged', t => {
  const { database } = setup(t)
  parents(database)
  const first = SEED_VIDEO_TAGS[0]
  const before = snapshot(database)
  const invalid = [null, {}, 'links', [null], [[]], Array(1), [first, undefined],
    [first, { ...first, tagName: '' }], [first, { ...first, tagName: '\u00a0\t' }],
    [first, { ...first, tagName: 3 }], [first, { ...first, tagName: 'x'.repeat(31) }],
    [first, { ...first, tagName: 'bad\0tag' }], [first, { ...first, videoPath: null }],
    [first, { ...first, videoPath: '../bad.mp4' }], [first, { ...first, videoPath: first.videoPath + '\n' }]]
  withTransaction(database, connection => {
    for (const links of invalid) {
      assert.throws(() => insertSeedVideoTags(connection, links))
      assert.deepEqual(snapshot(connection), before)
      assert.equal(connection.isTransaction, true)
    }
  })
  assert.deepEqual(seed(database, []), [])
  assert.deepEqual(snapshot(database), before)
  const frozen = Object.freeze([Object.freeze({ ...first }), Object.freeze({ ...first, tagName: ` ${first.tagName} ` })])
  const original = structuredClone(frozen)
  assert.equal(seed(database, frozen).length, 1)
  assert.deepEqual(frozen, original)
})

test('link seeding reads current parent IDs and links committed by another connection', t => {
  const { context, path, database } = setup(t)
  const other = context.open(path)
  parents(other)
  const result = seed(other)
  const before = snapshot(other)
  assert.deepEqual(seed(database), result)
  assert.deepEqual(snapshot(database), before)
})

test('link seeding requires an open connection and an active caller transaction', t => {
  const { database } = setup(t)
  parents(database)
  const before = snapshot(database)
  assert.throws(() => insertSeedVideoTags(database), { message: 'Seed video tag insertion requires an active transaction.' })
  assert.deepEqual(snapshot(database), before)
  closeDatabase(database)
  assert.throws(() => insertSeedVideoTags(database), { message: 'Database connection is closed.' })
  assert.equal(database.isOpen, false)
})

test('link seeding leaves rollback to the caller including parents written in the same transaction', t => {
  const { database } = setup(t)
  insertMinimalFixture(database)
  const before = snapshot(database)
  const failure = new Error('Expected seed links rollback')
  assert.throws(() => withTransaction(database, connection => {
    insertSeedVideos(connection)
    insertSeedTags(connection)
    insertSeedVideoTags(connection)
    assert.equal(connection.isTransaction, true)
    throw failure
  }), error => error === failure)
  assert.deepEqual(snapshot(database), before)
  assert.equal(database.isOpen, true)
  parents(database)
  assert.equal(seed(database).length, 10)
})

test('link seeding propagates storage errors and rolls back earlier pairs through the caller', t => {
  const { database } = setup(t)
  parents(database)
  const before = snapshot(database)
  assert.throws(() => withTransaction(database, connection => {
    insertSeedVideoTags(connection, [SEED_VIDEO_TAGS[0]])
    connection.exec('PRAGMA query_only = ON')
    insertSeedVideoTags(connection, [SEED_VIDEO_TAGS[1]])
  }), { code: 'ERR_SQLITE_ERROR', errcode: 8 })
  assert.deepEqual(snapshot(database), before)
  assert.equal(database.isOpen, true)
  assert.equal(database.isTransaction, false)
  database.exec('PRAGMA query_only = OFF')
  assert.equal(seed(database).length, 10)
})
