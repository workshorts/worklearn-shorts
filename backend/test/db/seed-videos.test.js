import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { closeDatabase } from '../../src/db/connection.js'
import { validateSeedMediaPaths } from '../../src/db/seed-media.js'
import { insertSeedVideos, SEED_VIDEOS } from '../../src/db/seed-videos.js'
import { withTransaction } from '../../src/db/transaction.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('seed-videos.db')
  context.initialize(path)
  return { context, path, database: context.open(path) }
}

function snapshot(database) {
  return Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}

function seed(database, samples) {
  return withTransaction(database, connection => insertSeedVideos(connection, samples))
}

test('default video manifest matches all eight reserved paths, titles and optional thumbnails', () => {
  const titles = ['실무 엑셀 기초', '웹 개발 입문', '업무 자동화 입문', '직장인 비즈니스 매너',
    '직장인을 위한 IT 기초', '기획안 · 보고서 작성법', '데이터 분석 입문', '효율적인 커뮤니케이션']
  const videoExtensions = ['mp4', 'webm', 'mp4', 'mp4', 'mp4', 'mp4', 'webm', 'mp4']
  const thumbnailExtensions = ['png', 'webp', null, 'jpg', null, 'png', 'webp', null]
  assert.equal(Object.isFrozen(SEED_VIDEOS), true)
  assert.deepEqual(SEED_VIDEOS.map(sample => sample.title), titles)
  for (let index = 0; index < 8; index += 1) {
    const sample = SEED_VIDEOS[index]
    const suffix = `00000000000${index + 1}`
    assert.equal(Object.isFrozen(sample), true)
    assert.equal(sample.videoPath, `videos/10000000-0000-4000-8000-${suffix}.${videoExtensions[index]}`)
    assert.equal(sample.thumbnailPath, thumbnailExtensions[index] === null ? null :
      `thumbnails/20000000-0000-4000-8000-${suffix}.${thumbnailExtensions[index]}`)
    assert.equal(sample.description, index === 4 ? '' : `${titles[index]}의 핵심을 짧게 배워보세요.`)
  }
  assert.equal(validateSeedMediaPaths(SEED_VIDEOS).length, 8)
})

test('seed videos store the baseline in order with database timestamps and persist after reopening', t => {
  const { context, path, database } = setup(t)
  const started = Date.now()
  const result = withTransaction(database, connection => {
    const videos = insertSeedVideos(connection)
    assert.equal(connection.isTransaction, true)
    return videos
  })
  const rows = database.prepare('SELECT * FROM videos ORDER BY id').all()
  assert.equal(rows.length, 8)
  assert.deepEqual(result, rows.map(row => ({ id: row.id, videoPath: row.video_path })))
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const sample = SEED_VIDEOS[index]
    assert.equal(row.title, sample.title)
    assert.equal(row.description, sample.description)
    assert.equal(row.thumbnail_path, sample.thumbnailPath)
    for (const timestamp of [row.created_at, row.updated_at]) {
      assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      assert.ok(Date.parse(timestamp) >= started && Date.parse(timestamp) <= Date.now())
    }
    if (index > 0) assert.ok(row.id > rows[index - 1].id)
  }
  for (const table of tables.filter(table => !['videos', 'sqlite_sequence'].includes(table))) {
    assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0)
  }
  const before = snapshot(database)
  closeDatabase(database)
  assert.deepEqual(snapshot(context.open(path)), before)
})

test('repeated video seeding preserves every row, sequence, timestamp and database bytes', t => {
  const { context, path, database } = setup(t)
  insertMinimalFixture(database)
  const result = seed(database)
  const before = snapshot(database)
  closeDatabase(database)
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
  const reopened = context.open(path)
  assert.deepEqual(seed(reopened), result)
  const changed = SEED_VIDEOS.map(sample => ({ ...sample, title: 'Changed title', description: 'Changed description', thumbnailPath: null }))
  assert.deepEqual(seed(reopened, changed), result)
  assert.deepEqual(snapshot(reopened), before)
  closeDatabase(reopened)
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), hash)
})

test('seed videos reuse actual existing IDs and preserve edited metadata and related activity', t => {
  const { database } = setup(t)
  const { videoId } = insertMinimalFixture(database)
  database.prepare('UPDATE videos SET video_path = ?, title = ?, updated_at = ? WHERE id = ?')
    .run(SEED_VIDEOS[2].videoPath, 'Owner edited title', '2020-01-02T03:04:05.000Z', videoId)
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
    .run(41, SEED_VIDEOS[0].title, 'videos/unrelated-existing.mp4')
  const before = snapshot(database)
  const result = seed(database)
  assert.equal(result[2].id, videoId)
  assert.ok(result[0].id > 41)
  const after = snapshot(database)
  assert.deepEqual(after.videos.slice(0, 2), before.videos)
  for (const table of tables.filter(table => !['videos', 'sqlite_sequence'].includes(table))) {
    assert.deepEqual(after[table], before[table])
  }
  assert.equal(after.videos.length, 9)
})

test('ambiguous existing paths fail before any video writes even when the last sample is ambiguous', t => {
  const { database } = setup(t)
  const insert = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
  insert.run('First owner video', SEED_VIDEOS[7].videoPath)
  insert.run('Second owner video', SEED_VIDEOS[7].videoPath)
  const before = snapshot(database)
  withTransaction(database, connection => {
    assert.throws(() => insertSeedVideos(connection), { code: 'AMBIGUOUS_SEED_VIDEO' })
    assert.deepEqual(snapshot(connection), before)
    assert.equal(connection.isTransaction, true)
  })
  assert.deepEqual(snapshot(database), before)
})

test('video identity uses exact paths while unrelated duplicate paths are preserved', t => {
  const { database } = setup(t)
  const insert = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
  insert.run('Uppercase extension', SEED_VIDEOS[0].videoPath.replace('.mp4', '.MP4'))
  insert.run('Unrelated duplicate one', 'videos/unrelated.mp4')
  insert.run('Unrelated duplicate two', 'videos/unrelated.mp4')
  const result = seed(database, [SEED_VIDEOS[0]])
  assert.equal(result.length, 1)
  assert.equal(database.prepare('SELECT count(*) AS count FROM videos').get().count, 4)
  assert.equal(database.prepare('SELECT video_path FROM videos WHERE id = ?').get(result[0].id).video_path, SEED_VIDEOS[0].videoPath)
})

test('seed video validation rejects invalid batches before writes and shares media path rules', t => {
  const { database } = setup(t)
  const before = snapshot(database)
  const sample = SEED_VIDEOS[1]
  const invalidManifests = [null, {}, [], [null], Array(1),
    [{ ...sample, videoPath: '../bad.mp4' }], [{ ...sample, thumbnailPath: '' }],
    [sample, { ...sample }], [sample, { ...sample, videoPath: sample.videoPath.toUpperCase() }],
    [{ ...sample, thumbnailPath: SEED_VIDEOS[0].thumbnailPath }, { ...SEED_VIDEOS[2], thumbnailPath: SEED_VIDEOS[0].thumbnailPath }]]
  withTransaction(database, connection => {
    for (const samples of invalidManifests) {
      assert.throws(() => insertSeedVideos(connection, samples), { code: 'INVALID_SEED_MEDIA' })
      assert.deepEqual(snapshot(connection), before)
    }
    const invalidMetadata = [
      { title: null }, { title: 'x' }, { title: 'x'.repeat(101) }, { title: 'bad\0title' },
      { description: null }, { description: 1 }, { description: 'x'.repeat(501) }, { description: 'bad\0text' }
    ]
    for (const metadata of invalidMetadata) {
      assert.throws(() => insertSeedVideos(connection, [SEED_VIDEOS[0], { ...sample, ...metadata }]), { name: 'TypeError' })
      assert.deepEqual(snapshot(connection), before)
    }
  })
})

test('seed videos accept metadata boundaries and default optional fields without changing frozen input', t => {
  const { database } = setup(t)
  const samples = Object.freeze([
    Object.freeze({ title: 'AB', videoPath: SEED_VIDEOS[0].videoPath }),
    Object.freeze({ title: 'T'.repeat(100), description: 'D'.repeat(500), videoPath: SEED_VIDEOS[1].videoPath }),
    Object.freeze({ ...SEED_VIDEOS[2], title: "' OR 1=1 --", description: "'; DROP TABLE videos; --" })
  ])
  const before = structuredClone(samples)
  seed(database, samples)
  const rows = database.prepare('SELECT * FROM videos ORDER BY id').all()
  assert.equal(rows[0].description, '')
  assert.equal(rows[0].thumbnail_path, null)
  assert.equal(rows[1].title.length, 100)
  assert.equal(rows[1].description.length, 500)
  assert.equal(rows[2].title, samples[2].title)
  assert.equal(rows[2].description, samples[2].description)
  assert.deepEqual(samples, before)
})

test('seed videos recheck paths committed by another connection and preserve its metadata', t => {
  const { context, path, database } = setup(t)
  const other = context.open(path)
  const result = seed(other, [{ ...SEED_VIDEOS[0], title: 'Other connection title' }])
  const before = snapshot(other)
  assert.deepEqual(seed(database, [SEED_VIDEOS[0]]), result)
  assert.deepEqual(snapshot(database), before)
})

test('seed video insertion requires an open connection and an active caller transaction', t => {
  const { database } = setup(t)
  const before = snapshot(database)
  assert.throws(() => insertSeedVideos(database), { message: 'Seed video insertion requires an active transaction.' })
  assert.deepEqual(snapshot(database), before)
  closeDatabase(database)
  assert.throws(() => insertSeedVideos(database), { message: 'Database connection is closed.' })
  assert.equal(database.isOpen, false)
})

test('seed videos leave rollback to the caller and restore sequences and existing data', t => {
  const { database } = setup(t)
  insertMinimalFixture(database)
  const before = snapshot(database)
  const failure = new Error('Expected seed video rollback')
  assert.throws(() => withTransaction(database, connection => {
    insertSeedVideos(connection)
    assert.equal(connection.isTransaction, true)
    throw failure
  }), error => error === failure)
  assert.deepEqual(snapshot(database), before)
  assert.equal(seed(database).length, 8)
})

test('seed videos propagate storage failures and allow recovery after caller rollback', t => {
  const { database } = setup(t)
  const before = snapshot(database)
  assert.throws(() => withTransaction(database, connection => {
    insertSeedVideos(connection, [SEED_VIDEOS[0]])
    connection.exec('PRAGMA query_only = ON')
    insertSeedVideos(connection, [SEED_VIDEOS[1]])
  }), { code: 'ERR_SQLITE_ERROR', errcode: 8 })
  assert.deepEqual(snapshot(database), before)
  assert.equal(database.isOpen, true)
  assert.equal(database.isTransaction, false)
  database.exec('PRAGMA query_only = OFF')
  assert.equal(seed(database).length, 8)
})
