import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { closeDatabase } from '../../src/db/connection.js'
import { insertSeedCourses, SEED_COURSES } from '../../src/db/seed-courses.js'
import { insertSeedVideos, SEED_VIDEOS } from '../../src/db/seed-videos.js'
import { withTransaction } from '../../src/db/transaction.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { createSeedMediaFixture } from '../helpers/seed-media-fixture.js'

const backend = fileURLToPath(new URL('../../', import.meta.url))
const tables = ['videos', 'courses', 'course_videos', 'sqlite_sequence']

function setup(t, name = 'seed-courses.db') {
  const context = createDatabaseContext(t)
  const path = context.path(name)
  context.initialize(path)
  return { context, path, database: context.open(path) }
}

function withVideos(database) {
  withTransaction(database, connection => insertSeedVideos(connection))
}

function seed(database, courses) {
  return withTransaction(database, connection => insertSeedCourses(connection, courses))
}

function snapshot(database) {
  return Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}

function storedCourses(database) {
  const courses = database.prepare('SELECT id, name, description FROM courses ORDER BY id').all()
  return courses.map(course => ({
    name: course.name,
    description: course.description,
    videoPaths: database.prepare(`SELECT v.video_path AS path FROM course_videos AS cv
      JOIN videos AS v ON v.id = cv.video_id WHERE cv.course_id = ? ORDER BY cv.sort_order`).all(course.id).map(row => row.path),
    sortOrders: database.prepare('SELECT sort_order FROM course_videos WHERE course_id = ? ORDER BY sort_order').all(course.id).map(row => row.sort_order)
  }))
}

test('기본 학습과정 목록은 과정 3개이고 영상 9개 연결이며 영상이 겹치는 과정도 있다', () => {
  assert.equal(SEED_COURSES.length, 3)
  assert.equal(SEED_COURSES.reduce((sum, course) => sum + course.videoPaths.length, 0), 9)
  const allPaths = SEED_COURSES.flatMap(course => course.videoPaths)
  assert.ok(new Set(allPaths).size < allPaths.length, '같은 영상이 여러 과정에 들어가는 경우를 포함해야 한다')
  const known = new Set(SEED_VIDEOS.map(video => video.videoPath))
  for (const path of allPaths) assert.ok(known.has(path))
  assert.equal(Object.isFrozen(SEED_COURSES), true)
})

test('과정과 영상 연결을 1부터 이어지는 순서로 저장한다', t => {
  const { database } = setup(t)
  withVideos(database)
  const result = seed(database)
  assert.deepEqual(result.map(course => course.created), [true, true, true])
  assert.deepEqual(result.map(course => course.videoCount), [3, 3, 3])
  const stored = storedCourses(database)
  assert.deepEqual(stored.map(course => course.name), SEED_COURSES.map(course => course.name))
  for (const [index, course] of stored.entries()) {
    assert.deepEqual(course.videoPaths, SEED_COURSES[index].videoPaths)
    assert.deepEqual(course.sortOrders, course.videoPaths.map((_, order) => order + 1))
  }
})

test('다시 실행해도 아무것도 바뀌지 않는다', t => {
  const { database } = setup(t)
  withVideos(database)
  seed(database)
  const first = snapshot(database)
  const second = seed(database)
  assert.deepEqual(second.map(course => course.created), [false, false, false])
  assert.deepEqual(snapshot(database), first)
})

test('관리자가 고친 과정(이름·설명·영상 구성)은 그대로 두고 지워진 과정만 다시 만든다', t => {
  const { database } = setup(t)
  withVideos(database)
  seed(database)
  withTransaction(database, connection => {
    connection.prepare('UPDATE courses SET description = ? WHERE name = ?').run('직접 고친 설명', SEED_COURSES[0].name)
    connection.prepare('DELETE FROM course_videos WHERE course_id = (SELECT id FROM courses WHERE name = ?)').run(SEED_COURSES[1].name)
    connection.prepare('DELETE FROM courses WHERE name = ?').run(SEED_COURSES[2].name)
  })
  const before = storedCourses(database)
  const result = seed(database)
  assert.deepEqual(result.map(course => course.created), [false, false, true])
  const after = storedCourses(database)
  assert.equal(after[0].description, '직접 고친 설명')
  assert.deepEqual(after[1].videoPaths, [], '비워 둔 과정의 구성은 되살리지 않는다')
  assert.deepEqual(after.slice(0, 2), before.slice(0, 2))
  assert.deepEqual(after[2].videoPaths, SEED_COURSES[2].videoPaths)
})

test('샘플 영상이 없으면 오류 코드로 멈추고 아무것도 저장하지 않는다', t => {
  const { database } = setup(t)
  const before = snapshot(database)
  assert.throws(() => seed(database), error => error.code === 'MISSING_SEED_COURSE_VIDEO')
  assert.deepEqual(snapshot(database), before)
  assert.equal(database.isTransaction, false)
})

test('영상이 하나만 없어도 모든 과정이 저장되지 않는다', t => {
  const { database } = setup(t)
  withVideos(database)
  withTransaction(database, connection => {
    connection.prepare('DELETE FROM videos WHERE video_path = ?').run(SEED_COURSES[2].videoPaths[2])
  })
  const before = snapshot(database)
  assert.throws(() => seed(database), error => error.code === 'MISSING_SEED_COURSE_VIDEO')
  assert.deepEqual(snapshot(database), before)
})

test('같은 경로의 영상이 둘이면 모호하다며 멈춘다', t => {
  const { database } = setup(t)
  withVideos(database)
  withTransaction(database, connection => {
    connection.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)').run('중복 영상', SEED_VIDEOS[0].videoPath)
  })
  assert.throws(() => seed(database), error => error.code === 'AMBIGUOUS_SEED_VIDEO')
})

test('같은 이름의 과정이 이미 둘이면 모호하다며 멈춘다', t => {
  const { database } = setup(t)
  withVideos(database)
  withTransaction(database, connection => {
    const insert = connection.prepare('INSERT INTO courses (name) VALUES (?)')
    insert.run(SEED_COURSES[0].name)
    insert.run(SEED_COURSES[0].name)
  })
  assert.throws(() => seed(database), error => error.code === 'AMBIGUOUS_SEED_COURSE')
})

test('트랜잭션 밖에서 부르거나 잘못된 입력이면 거절한다', t => {
  const { database } = setup(t)
  withVideos(database)
  assert.throws(() => insertSeedCourses(database), /active transaction/)
  const path = SEED_VIDEOS[0].videoPath
  for (const course of [
    { name: 'a', videoPaths: [path] },
    { name: 'x'.repeat(51), videoPaths: [path] },
    { name: '정상 이름', description: 'x'.repeat(301), videoPaths: [path] },
    { name: '정상 이름', videoPaths: [] },
    { name: '정상 이름', videoPaths: [path, path] },
    { name: '정상 이름', videoPaths: ['videos/not-a-uuid.mp4'] },
    null
  ]) {
    assert.throws(() => seed(database, [course]), error => error instanceof TypeError || error.code === 'INVALID_SEED_MEDIA')
  }
  assert.throws(() => seed(database, [{ name: '같은 이름', videoPaths: [path] }, { name: '같은 이름', videoPaths: [path] }]), TypeError)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM courses').get().count, 0)
})

function runCli(state, { uploadDir } = {}) {
  const env = { ...process.env, NODE_NO_WARNINGS: '1', DB_PATH: state.path, ADMIN_USERNAME: 'cli-admin', ADMIN_PASSWORD: 'cli-test-password' }
  if (uploadDir) env.UPLOAD_DIR = uploadDir
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_OPTIONS
  return spawnSync(process.execPath, [join(backend, 'db', 'seed-courses.js')], { cwd: state.context.directory, env, encoding: 'utf8', timeout: 25000 })
}

test('명령: 샘플 영상이 없으면 안내 문구와 함께 실패한다', { timeout: 30000 }, t => {
  const { context, path, database } = setup(t, 'cli-empty.db')
  closeDatabase(database)
  const result = runCli({ context, path })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Run npm run db:seed first/)
  assert.equal(result.stderr.includes(path), false)
})

test('명령: db:seed 다음에 실행하면 3개 과정을 만들고 다시 실행해도 같다', { timeout: 60000 }, t => {
  const { context, path, database } = setup(t, 'cli-ok.db')
  closeDatabase(database)
  const uploadDir = createSeedMediaFixture(context)
  const seedRun = spawnSync(process.execPath, [join(backend, 'db', 'seed.js')], {
    cwd: context.directory, encoding: 'utf8', timeout: 25000,
    env: { ...process.env, NODE_NO_WARNINGS: '1', DB_PATH: path, UPLOAD_DIR: uploadDir, ADMIN_USERNAME: 'cli-admin', ADMIN_PASSWORD: 'cli-test-password', NODE_TEST_CONTEXT: undefined }
  })
  assert.equal(seedRun.status, 0, seedRun.stderr)

  const first = runCli({ context, path }, { uploadDir })
  assert.equal(first.status, 0, first.stderr)
  assert.equal(first.stdout.trim(), 'Course samples ready. Courses: 3 (created: 3); links: 9.')
  assert.equal(first.stderr, '')

  const second = runCli({ context, path }, { uploadDir })
  assert.equal(second.status, 0, second.stderr)
  assert.equal(second.stdout.trim(), 'Course samples ready. Courses: 3 (created: 0); links: 9.')

  const check = context.open(path)
  assert.equal(check.prepare('SELECT COUNT(*) AS count FROM courses').get().count, 3)
  assert.equal(check.prepare('SELECT COUNT(*) AS count FROM course_videos').get().count, 9)
})
