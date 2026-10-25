import assert from 'node:assert/strict'
import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const timeout = 10000

test('contexts use independent files and close every connection before removal', { timeout }, async t => {
  const first = createDatabaseContext(t)
  const second = createDatabaseContext(t)
  const firstPath = first.path('app.db')
  const secondPath = second.path('app.db')
  assert.notEqual(first.directory, second.directory)
  first.initialize(firstPath)
  second.initialize(secondPath)
  const a = first.open(firstPath)
  const b = first.open(firstPath)
  const other = second.open(secondPath)
  a.prepare('INSERT INTO tags (name) VALUES (?)').run('Only first')
  assert.equal(b.prepare('SELECT count(*) AS count FROM tags').get().count, 1)
  assert.equal(other.prepare('SELECT count(*) AS count FROM tags').get().count, 0)
  await first.cleanup()
  assert.equal(a.isOpen, false)
  assert.equal(b.isOpen, false)
  assert.equal(existsSync(first.directory), false)
  assert.equal(other.isOpen, true)
  await second.cleanup()
  assert.equal(other.isOpen, false)
  assert.equal(existsSync(second.directory), false)
})

test('explicit owned paths are required regardless of DB_PATH', { timeout }, t => {
  const context = createDatabaseContext(t)
  const outside = createDatabaseContext(t)
  const sentinel = outside.path('preserved.db')
  writeFileSync(sentinel, 'existing database bytes')
  const previousPath = process.env.DB_PATH
  process.env.DB_PATH = sentinel

  try {
    for (const path of [undefined, '', 'relative.db', context.directory, sentinel]) {
      assert.throws(() => context.initialize(path), /explicit path/)
      assert.throws(() => context.open(path), /explicit path/)
    }

    assert.throws(() => context.path('..', 'outside.db'), /explicit path/)
    assert.throws(() => context.path(), /explicit path/)
    assert.equal(readFileSync(sentinel, 'utf8'), 'existing database bytes')
  } finally {
    if (previousPath === undefined) delete process.env.DB_PATH
    else process.env.DB_PATH = previousPath
  }
})

test('minimal fixtures populate the related tables without service seed or media', { timeout }, t => {
  const context = createDatabaseContext(t)
  const path = context.path('nested', 'fixture.db')
  context.initialize(path)
  const database = context.open(path)
  const ids = insertMinimalFixture(database)
  assert.ok(ids.videoId > 0)
  assert.ok(ids.correctOptionId !== ids.incorrectOptionId)
  const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
    'video_views', 'video_likes', 'comments', 'quizzes']

  for (const table of tables) {
    assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 1)
  }

  assert.equal(database.prepare('SELECT count(*) AS count FROM quiz_options').get().count, 2)
  assert.equal(database.prepare('SELECT video_id FROM comments WHERE id = ?').get(ids.commentId).video_id, ids.videoId)
  assert.equal(database.prepare('SELECT is_correct FROM quiz_options WHERE id = ?').get(ids.correctOptionId).is_correct, 1)
  assert.equal(existsSync(context.path('uploads')), false)
})

test('registered shutdown runs in reverse order before database connections close', { timeout }, async t => {
  const context = createDatabaseContext(t)
  const path = context.path('app.db')
  context.initialize(path)
  const database = context.open(path)
  const events = []
  context.addCleanup(() => { assert.equal(database.isOpen, true); events.push('first') })
  context.addCleanup(async () => { assert.equal(database.isOpen, true); events.push('second') })
  await context.cleanup()
  assert.deepEqual(events, ['second', 'first'])
  assert.equal(database.isOpen, false)
  await context.cleanup()
  assert.deepEqual(events, ['second', 'first'])
  assert.throws(() => context.open(path), /cleanup has already started/)
  assert.throws(() => context.path('another.db'), /cleanup has already started/)
})

test('failed shutdown preserves its cause and directory but still closes databases', { timeout }, async t => {
  const context = createDatabaseContext(t)
  const path = context.path('app.db')
  context.initialize(path)
  const database = context.open(path)
  const error = new Error('Expected shutdown failure')
  let fail = true
  context.addCleanup(() => { if (fail) throw error })
  await assert.rejects(context.cleanup(), candidate => candidate === error)
  assert.equal(database.isOpen, false)
  assert.equal(existsSync(path), true)
  fail = false
  await context.cleanup()
  assert.equal(existsSync(context.directory), false)
})

test('connection cleanup failures do not prevent other connection cleanup', { timeout }, async t => {
  const context = createDatabaseContext(t)
  const path = context.path('app.db')
  context.initialize(path)
  const first = context.open(path)
  const second = context.open(path)
  const close = first.close
  const error = new Error('Expected connection close failure')
  first.close = () => { throw error }

  try {
    await assert.rejects(context.cleanup(), candidate => candidate === error)
    assert.equal(first.isOpen, true)
    assert.equal(second.isOpen, false)
    assert.equal(existsSync(context.directory), true)
  } finally {
    first.close = close
  }

  await context.cleanup()
  assert.equal(first.isOpen, false)
})

test('cleanup retains all failed shutdown causes', { timeout }, async t => {
  const context = createDatabaseContext(t)
  const first = new Error('Expected first shutdown failure')
  const second = new Error('Expected second shutdown failure')
  let fail = true
  context.addCleanup(() => { if (fail) throw first })
  context.addCleanup(() => { if (fail) throw second })
  await assert.rejects(context.cleanup(), error => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [second, first])
    return true
  })
  assert.equal(existsSync(context.directory), true)
  fail = false
  await context.cleanup()
})

test('symbolic links cannot redirect database paths or recursive cleanup', { timeout }, async t => {
  const context = createDatabaseContext(t)
  const outside = createDatabaseContext(t)
  const sentinel = outside.path('preserved.txt')
  const link = context.path('linked')
  writeFileSync(sentinel, 'preserve linked directory')
  symlinkSync(outside.directory, link, process.platform === 'win32' ? 'junction' : 'dir')

  try {
    assert.throws(() => context.path('linked', 'app.db'), /symbolic links/)
    assert.throws(() => context.initialize(join(link, 'app.db')), /symbolic links/)
    await assert.rejects(context.cleanup(), /symbolic link/)
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve linked directory')
    assert.equal(existsSync(context.directory), true)
  } finally {
    unlinkSync(link)
  }

  await context.cleanup()
})

test('automatic after cleanup runs after a test body fails', { timeout: 30000 }, t => {
  const context = createDatabaseContext(t)
  const childTest = context.path('failure.test.mjs')
  const helperUrl = new URL('../helpers/database-context.js', import.meta.url).href
  writeFileSync(childTest, [
    "import test from 'node:test'",
    `import { createDatabaseContext } from ${JSON.stringify(helperUrl)}`,
    "test('intentional fixture body failure', t => {",
    '  const context = createDatabaseContext(t)',
    "  const path = context.path('app.db')",
    '  context.initialize(path)',
    '  context.open(path)',
    "  console.log('WORKSPACE=' + JSON.stringify(context.directory))",
    "  throw new Error('Expected fixture body failure')",
    '})'
  ].join('\n'))
  const childEnvironment = { ...process.env }
  // Start a separate runner rather than inheriting the parent runner context.
  delete childEnvironment.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', childTest], {
    env: childEnvironment, encoding: 'utf8', timeout: 20000, windowsHide: true
  })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 1)
  assert.match(result.stdout + result.stderr, /Expected fixture body failure/)
  const match = result.stdout.match(/WORKSPACE=("[^\r\n]+")/)
  assert.ok(match)
  assert.equal(existsSync(JSON.parse(match[1])), false)
})
