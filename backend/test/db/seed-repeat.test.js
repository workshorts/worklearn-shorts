import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { closeDatabase } from '../../src/db/connection.js'
import { openSeedDatabase } from '../../src/db/seed-preflight.js'
import { seedDatabase } from '../../src/db/seed.js'
import { SEED_VIDEOS } from '../../src/db/seed-videos.js'
import { withTransaction } from '../../src/db/transaction.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'
import { createSeedMediaFixture } from '../helpers/seed-media-fixture.js'

const backend = fileURLToPath(new URL('../../', import.meta.url))
const credentials = { ADMIN_USERNAME: 'repeat-seed-admin', ADMIN_PASSWORD: 'repeat-test-only-password' }
const tables = ['admins', 'tags', 'videos', 'video_tags', 'courses', 'course_videos',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']
const baselineCounts = {
  admins: 1, tags: 7, videos: 8, video_tags: 10, courses: 0, course_videos: 0,
  video_views: 0, video_likes: 0, comments: 0, quizzes: 0, quiz_options: 0
}

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('repeat-seed.db')
  context.initialize(path)
  return { context, path, uploadDir: createSeedMediaFixture(context) }
}

function readState(state) {
  const database = state.context.open(state.path)
  try {
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
    return {
      schema: database.prepare('SELECT type, name, tbl_name, rootpage, sql FROM sqlite_schema ORDER BY type, name').all(),
      rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
    }
  } finally {
    closeDatabase(database)
  }
}

function assertBaseline(contents) {
  assert.deepEqual(Object.fromEntries(Object.keys(baselineCounts).map(table => [table, contents.rows[table].length])), baselineCounts)
  assert.equal(contents.rows.admins[0].username, credentials.ADMIN_USERNAME)
  assert.match(contents.rows.admins[0].password_hash, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/)
}

function fingerprint(path) {
  const stat = lstatSync(path, { bigint: true })
  return { hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
    size: stat.size, mtimeNs: stat.mtimeNs, dev: stat.dev, ino: stat.ino }
}

function files(state) {
  for (const suffix of ['-journal', '-wal', '-shm']) assert.equal(existsSync(state.path + suffix), false)
  const media = SEED_VIDEOS.flatMap(({ videoPath, thumbnailPath }) => [videoPath, thumbnailPath].filter(path => path !== null))
  assert.equal(media.length, 13)
  return { database: fingerprint(state.path), media: media.map(path => [path, fingerprint(join(state.uploadDir, path))]) }
}

async function runFunction(state, environment = credentials) {
  const database = openSeedDatabase(state.path)
  state.context.addCleanup(() => closeDatabase(database))
  try {
    return await seedDatabase(database, { environment, uploadDir: state.uploadDir })
  } finally {
    closeDatabase(database)
  }
}

function runNpm(state, created) {
  const npm = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(path => path && existsSync(path))
  assert.ok(npm, 'The npm CLI is required to verify repeated package-script execution.')
  const environment = { ...process.env, ...credentials, DB_PATH: state.path, UPLOAD_DIR: state.uploadDir, NODE_NO_WARNINGS: '1' }
  delete environment.NODE_TEST_CONTEXT
  delete environment.NODE_OPTIONS
  const result = spawnSync(process.execPath, [npm, '--silent', 'run', 'db:seed'], {
    cwd: backend, env: environment, encoding: 'utf8', timeout: 25000, windowsHide: true
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout.trim(), `Database seeded successfully. Administrator ${created ? 'created' : 'preserved'}; baseline tags: 7; videos: 8; links: 10.`)
  for (const value of [credentials.ADMIN_USERNAME, credentials.ADMIN_PASSWORD, state.path, state.uploadDir, 'scrypt$']) {
    assert.equal(result.stdout.includes(value), false)
  }
}

test('two full function seed runs preserve every row, schema, sequence, administrator hash and file', async t => {
  const state = setup(t)
  const initialMedia = files(state).media
  assert.deepEqual(await runFunction(state), { administratorCreated: true, tagCount: 7, videoCount: 8, videoTagCount: 10 })
  const first = readState(state)
  assertBaseline(first)
  const firstFiles = files(state)
  assert.deepEqual(firstFiles.media, initialMedia)
  assert.deepEqual(await runFunction(state), { administratorCreated: false, tagCount: 7, videoCount: 8, videoTagCount: 10 })
  assert.deepEqual(readState(state), first)
  assert.deepEqual(files(state), firstFiles)
})

test('two separate npm seed processes preserve the committed baseline and existing administrator hash', { timeout: 60000 }, t => {
  const state = setup(t)
  const initialMedia = files(state).media
  runNpm(state, true)
  const first = readState(state)
  assertBaseline(first)
  const firstFiles = files(state)
  assert.deepEqual(firstFiles.media, initialMedia)
  runNpm(state, false)
  assert.deepEqual(readState(state), first)
  assert.deepEqual(files(state), firstFiles)
})

test('full seed repetition preserves owner edits, extra relationships and the hash after an environment password change', async t => {
  const state = setup(t)
  await runFunction(state)
  const database = state.context.open(state.path)
  const originalAdmin = database.prepare('SELECT * FROM admins WHERE username = ?').get(credentials.ADMIN_USERNAME)
  const fixture = insertMinimalFixture(database)
  withTransaction(database, connection => {
    connection.prepare('UPDATE videos SET title = ?, description = ?, thumbnail_path = NULL, created_at = ?, updated_at = ? WHERE video_path = ?')
      .run('Owner edited video', 'Owner edited description', '2000-01-02T03:04:05.000Z', '2001-02-03T04:05:06.000Z', SEED_VIDEOS[0].videoPath)
    connection.prepare('UPDATE tags SET name = ? WHERE name = ?').run(' \t기획/pm\u00a0', '기획/PM')
    const videoId = connection.prepare('SELECT id FROM videos WHERE video_path = ?').get(SEED_VIDEOS[4].videoPath).id
    connection.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(videoId, fixture.tagId)
    const tagId = connection.prepare('SELECT id FROM tags WHERE name = ?').get('엑셀').id
    connection.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(fixture.videoId, tagId)
  })
  closeDatabase(database)
  const before = readState(state)
  const beforeFiles = files(state)
  assert.equal(before.rows.video_tags.length, 13)
  const result = await runFunction(state, { ...credentials, ADMIN_PASSWORD: 'different-test-only-password' })
  assert.equal(result.administratorCreated, false)
  const after = readState(state)
  assert.deepEqual(after, before)
  assert.deepEqual(after.rows.admins.find(row => row.username === credentials.ADMIN_USERNAME), originalAdmin)
  assert.deepEqual(files(state), beforeFiles)
})

test('full seed repetition restores only missing baseline data using new IDs and preserves surviving records', async t => {
  const state = setup(t)
  await runFunction(state)
  const database = state.context.open(state.path)
  const removedVideo = database.prepare('SELECT * FROM videos WHERE video_path = ?').get(SEED_VIDEOS[1].videoPath)
  const removedTag = database.prepare('SELECT * FROM tags WHERE name = ?').get('데이터 분석')
  withTransaction(database, connection => {
    connection.prepare('DELETE FROM videos WHERE id = ?').run(removedVideo.id)
    connection.prepare('DELETE FROM tags WHERE id = ?').run(removedTag.id)
    const videoId = connection.prepare('SELECT id FROM videos WHERE video_path = ?').get(SEED_VIDEOS[0].videoPath).id
    const tagId = connection.prepare('SELECT id FROM tags WHERE name = ?').get('엑셀').id
    connection.prepare('DELETE FROM video_tags WHERE video_id = ? AND tag_id = ?').run(videoId, tagId)
  })
  closeDatabase(database)
  const before = readState(state)
  const media = files(state).media
  const result = await runFunction(state)
  assert.equal(result.administratorCreated, false)
  const after = readState(state)
  assertBaseline(after)
  for (const table of ['admins', 'courses', 'course_videos', 'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options']) {
    assert.deepEqual(after.rows[table], before.rows[table])
  }
  for (const table of ['videos', 'tags', 'video_tags']) {
    for (const row of before.rows[table]) assert.ok(after.rows[table].some(candidate => JSON.stringify(candidate) === JSON.stringify(row)))
  }
  const restoredVideo = after.rows.videos.find(row => row.video_path === removedVideo.video_path)
  const restoredTag = after.rows.tags.find(row => row.name === removedTag.name)
  assert.ok(restoredVideo.id > Math.max(removedVideo.id, ...before.rows.videos.map(row => row.id)))
  assert.ok(restoredTag.id > Math.max(removedTag.id, ...before.rows.tags.map(row => row.id)))
  for (const table of ['admins', 'tags', 'videos']) {
    const previous = before.rows.sqlite_sequence.find(row => row.name === table).seq
    const current = after.rows.sqlite_sequence.find(row => row.name === table).seq
    assert.equal(current, previous + (table === 'admins' ? 0 : 1))
  }
  assert.deepEqual(files(state).media, media)
})
