import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { closeDatabase } from '../../src/db/connection.js'
import { SEED_VIDEOS } from '../../src/db/seed-videos.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'
import { createSeedMediaFixture } from '../helpers/seed-media-fixture.js'

const backend = fileURLToPath(new URL('../../', import.meta.url))
const entry = join(backend, 'db', 'seed.js')
const worker = new URL('../helpers/seed-cli-failure-worker.js', import.meta.url).href
const username = 'cli-private-admin'
const password = 'cli-private-password'
const success = 'Database seeded successfully. Administrator created; baseline tags: 7; videos: 8; links: 10.'
const tables = ['admins', 'tags', 'videos', 'video_tags', 'courses', 'course_videos',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('명령 테스트 # %', 'app.db')
  context.initialize(path)
  return { context, path, uploadDir: createSeedMediaFixture(context) }
}

function run(state, { args = [], env = {}, nodeArgs = [], target = entry, cwd = state.context.directory } = {}) {
  const environment = {
    ...process.env, NODE_NO_WARNINGS: '1', DB_PATH: state.path, UPLOAD_DIR: state.uploadDir,
    ADMIN_USERNAME: username, ADMIN_PASSWORD: password, ...env
  }
  delete environment.NODE_TEST_CONTEXT
  delete environment.NODE_OPTIONS
  for (const key of Object.keys(environment)) if (environment[key] === undefined) delete environment[key]
  const result = spawnSync(process.execPath, [...nodeArgs, target, ...args], {
    cwd, env: environment, encoding: 'utf8', timeout: 25000, windowsHide: true
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.signal, null, result.stderr)
  return result
}

function contents(state) {
  const database = state.context.open(state.path)
  try {
    return Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
  } finally {
    closeDatabase(database)
  }
}

function fingerprint(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function assertPrivate(result, state) {
  const output = result.stdout + result.stderr
  for (const value of [username, password, state.path, state.uploadDir, 'scrypt$', 'Private write detail', 'Private close detail']) {
    assert.equal(output.includes(value), false, value)
  }
}

function copyBackend(context) {
  const directory = context.path('backend-copy')
  mkdirSync(join(directory, 'db'), { recursive: true })
  copyFileSync(entry, join(directory, 'db', 'seed.js'))
  copyFileSync(join(backend, 'package.json'), join(directory, 'package.json'))
  cpSync(join(backend, 'src'), join(directory, 'src'), { recursive: true })
  cpSync(join(backend, 'node_modules'), join(directory, 'node_modules'), { recursive: true, dereference: true })
  return directory
}

test('seed CLI succeeds from another cwd and persists the baseline before reporting success', { timeout: 30000 }, t => {
  const state = setup(t)
  const trace = state.context.path('close-trace.json')
  const result = run(state, { nodeArgs: ['--import', worker], env: { TEST_SEED_CLI_TRACE: trace, TEST_SEED_CLI_FAILURE: 'observe', AUTH_SECRET: undefined } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), success)
  assert.equal(result.stderr, '')
  assertPrivate(result, state)
  assert.deepEqual(JSON.parse(readFileSync(trace, 'utf8')), { closes: 1, openAfterClose: false, transactionBeforeClose: false })
  const rows = contents(state)
  assert.equal(rows.admins.length, 1)
  assert.equal(rows.tags.length, 7)
  assert.equal(rows.videos.length, 8)
  assert.equal(rows.video_tags.length, 10)
  for (const table of ['courses', 'course_videos', 'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options']) assert.equal(rows[table].length, 0)
})

test('npm run db:seed invokes the real package script against an isolated database', { timeout: 30000 }, t => {
  const state = setup(t)
  const npm = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(path => path && existsSync(path))
  assert.ok(npm, 'The npm CLI must be available to verify the package script.')
  const result = run(state, { target: npm, args: ['--silent', 'run', 'db:seed'], cwd: backend })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), success)
  assert.equal(contents(state).video_tags.length, 10)
  assertPrivate(result, state)
})

test('seed CLI refuses extra arguments before opening or creating a database', { timeout: 30000 }, t => {
  const context = createDatabaseContext(t)
  const state = { context, path: context.path('missing', 'app.db'), uploadDir: context.path('missing-media') }
  for (const args of [['--force'], ['another.db']]) {
    const result = run(state, { args })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /db:seed accepts no arguments/)
    assertPrivate(result, state)
    assert.deepEqual(readdirSync(context.directory), [])
  }
})

test('seed CLI refuses an uninitialized target without creating its file or parent', { timeout: 30000 }, t => {
  const context = createDatabaseContext(t)
  const state = { context, path: context.path('not-created', 'app.db'), uploadDir: context.path('not-created-media') }
  const result = run(state)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Check access to an initialized database/)
  assertPrivate(result, state)
  assert.deepEqual(readdirSync(context.directory), [])
})

test('seed CLI rejects an incompatible schema without changing existing database bytes', { timeout: 30000 }, t => {
  const state = setup(t)
  const database = state.context.open(state.path)
  insertMinimalFixture(database)
  database.exec('CREATE TABLE extra_for_cli_test (id INTEGER PRIMARY KEY)')
  closeDatabase(database)
  const before = fingerprint(state.path)
  const result = run(state)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /existing database schema is incompatible/)
  assert.equal(fingerprint(state.path), before)
  assertPrivate(result, state)
})

test('seed CLI reports invalid administrator settings with a nonzero exit and no writes', { timeout: 30000 }, t => {
  const state = setup(t)
  const before = contents(state)
  const hash = fingerprint(state.path)
  const result = run(state, { env: { ADMIN_PASSWORD: '' } })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /configure ADMIN_USERNAME .* and ADMIN_PASSWORD/)
  assert.deepEqual(contents(state), before)
  assert.equal(fingerprint(state.path), hash)
  assertPrivate(result, state)
})

test('seed CLI reports unavailable media without leaking paths or leaving seed records', { timeout: 30000 }, t => {
  const state = setup(t)
  unlinkSync(join(state.uploadDir, SEED_VIDEOS[7].videoPath))
  const before = contents(state)
  const hash = fingerprint(state.path)
  const result = run(state)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /sample media is missing or invalid/)
  assert.deepEqual(contents(state), before)
  assert.equal(fingerprint(state.path), hash)
  assertPrivate(result, state)
})

test('seed CLI loads backend-local env paths from another cwd and respects process overrides', { timeout: 30000 }, t => {
  const state = setup(t)
  const copied = copyBackend(state.context)
  const envPath = join(copied, '.env')
  const localPath = join(copied, 'data', 'app.db')
  state.context.initialize(localPath)
  writeFileSync(envPath, 'DB_PATH=./data/app.db\nUPLOAD_DIR=../seed-uploads\nADMIN_USERNAME=env-file-admin\nADMIN_PASSWORD=env-file-test-password\n')
  const fromFile = run(state, { target: join(copied, 'db', 'seed.js'), env: { DB_PATH: undefined, UPLOAD_DIR: undefined, ADMIN_USERNAME: undefined, ADMIN_PASSWORD: undefined } })
  assert.equal(fromFile.status, 0, fromFile.stderr)
  assert.equal(fromFile.stdout.trim(), success)
  assert.equal(contents({ ...state, path: localPath }).admins[0].username, 'env-file-admin')
  const override = run(state, { target: join(copied, 'db', 'seed.js') })
  assert.equal(override.status, 0, override.stderr)
  assert.equal(contents(state).admins[0].username, username)
  assert.equal(contents({ ...state, path: localPath }).admins.length, 1)
})

test('seed CLI catches configuration import failures without exposing stack traces or touching the database', { timeout: 30000 }, t => {
  const state = setup(t)
  const copied = copyBackend(state.context)
  mkdirSync(join(copied, '.env'))
  const before = fingerprint(state.path)
  const result = run(state, { target: join(copied, 'db', 'seed.js') })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Database seeding failed/)
  assert.doesNotMatch(result.stderr, /Unable to load|Error:|file:\/\//)
  assert.equal(fingerprint(state.path), before)
  assertPrivate(result, state)
})

test('seed CLI reports an existing administrator as preserved without replacing its stored hash', { timeout: 30000 }, t => {
  const state = setup(t)
  const database = state.context.open(state.path)
  database.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(username, 'existing-test-only-hash', '2020-01-02T03:04:05.000Z')
  const before = database.prepare('SELECT * FROM admins').get()
  closeDatabase(database)
  const result = run(state)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), success.replace('Administrator created', 'Administrator preserved'))
  assert.deepEqual(contents(state).admins, [before])
  assertPrivate(result, state)
})

test('seed CLI reports a close failure after commit without printing a false success or claiming rollback', { timeout: 30000 }, t => {
  const state = setup(t)
  const trace = state.context.path('close-failure.json')
  const result = run(state, { nodeArgs: ['--import', worker], env: { TEST_SEED_CLI_TRACE: trace, TEST_SEED_CLI_FAILURE: 'close' } })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /seeding committed, but closing the database failed/)
  assertPrivate(result, state)
  assert.equal(contents(state).video_tags.length, 10)
  assert.deepEqual(JSON.parse(readFileSync(trace, 'utf8')), { closes: 1, openAfterClose: false, transactionBeforeClose: false })
})

test('seed CLI closes the connection after write failure and reports a second cleanup error safely', { timeout: 30000 }, t => {
  const state = setup(t)
  const database = state.context.open(state.path)
  insertMinimalFixture(database)
  closeDatabase(database)
  const before = contents(state)
  const trace = state.context.path('write-close-failure.json')
  const result = run(state, { nodeArgs: ['--import', worker], env: { TEST_SEED_CLI_TRACE: trace, TEST_SEED_CLI_FAILURE: 'write-close' } })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Database seeding failed/)
  assert.match(result.stderr, /connection cleanup also failed/)
  assertPrivate(result, state)
  assert.deepEqual(contents(state), before)
  assert.deepEqual(JSON.parse(readFileSync(trace, 'utf8')), { closes: 1, openAfterClose: false, transactionBeforeClose: false })
})
