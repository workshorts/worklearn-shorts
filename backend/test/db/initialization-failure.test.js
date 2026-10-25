import assert from 'node:assert/strict'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'
import { closeDatabase } from '../../src/db/connection.js'
import { verifyDatabaseSchema } from '../../src/db/schema-validation.js'

function fingerprint(path) {
  const stat = lstatSync(path, { bigint: true })
  return {
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
    size: stat.size, mtimeNs: stat.mtimeNs, dev: stat.dev, ino: stat.ino
  }
}

function prepareContext(t) {
  const context = createDatabaseContext(t)
  const protectedPath = context.path('existing.db')
  const sentinel = context.path('keep.txt')
  context.initialize(protectedPath)
  const database = context.open(protectedPath)

  try {
    insertMinimalFixture(database)
  } finally {
    closeDatabase(database)
  }

  writeFileSync(sentinel, 'Existing unrelated file')
  const original = fingerprint(protectedPath)
  const sentinelOriginal = fingerprint(sentinel)
  return {
    context,
    path: context.path('incomplete.db'),
    protectedPath,
    assertPreserved() {
      assert.deepEqual(fingerprint(protectedPath), original)
      assert.deepEqual(fingerprint(sentinel), sentinelOriginal)
    }
  }
}

function runFailure(setup, mode, path = setup.path) {
  const entry = fileURLToPath(new URL('../helpers/initialization-failure-worker.js', import.meta.url))
  const environment = {
    ...process.env,
    DB_PATH: path,
    TEST_DB_INITIALIZATION_FAILURE: mode,
    TEST_DB_PROTECTED_PATH: setup.protectedPath
  }
  delete environment.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [entry], {
    cwd: setup.context.directory,
    env: environment,
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 1, result.stderr)
  assert.doesNotMatch(result.stdout, /Database initialized successfully\./)
  const reports = [...result.stdout.matchAll(/^FAILURE_REPORT=(.+)$/gm)]
  assert.equal(reports.length, 1, result.stdout + result.stderr)
  const report = JSON.parse(reports[0][1])
  assert.equal(report.descriptorsClosed, true)
  assert.equal(report.connectionsClosed, true)
  setup.assertPreserved()
  return { ...result, report }
}

for (const [mode, expectedError] of [
  ['read', /ERR_TEST_SCHEMA_READ/],
  ['ddl', /syntax error/],
  ['validation', /INVALID_DATABASE_SCHEMA/],
  ['commit', /ERR_TEST_COMMIT/]
]) {
  test(`initialization ${mode} failure leaves no schema and removes only the incomplete database`, { timeout: 30000 }, t => {
    const setup = prepareContext(t)
    const result = runFailure(setup, mode)
    assert.match(result.stderr, /Database initialization failed:/)
    assert.match(result.stderr, expectedError)
    assert.equal(result.report.schemaRead, true)
    assert.equal(result.report.createdFiles, 1)
    assert.deepEqual(result.report.beforeClose, [{ schemaObjects: 0, transaction: false }])

    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      assert.equal(existsSync(setup.path + suffix), false)
    }
  })
}

test('removal failure preserves both causes and leaves a rolled-back file for inspection', { timeout: 30000 }, t => {
  const setup = prepareContext(t)
  const result = runFailure(setup, 'unlink')
  assert.match(result.stderr, /Database initialization failed:/)
  assert.match(result.stderr, /AggregateError/)
  assert.match(result.stderr, /ERR_TEST_SCHEMA_READ/)
  assert.match(result.stderr, /Injected file removal failure/)
  assert.equal(result.report.createdFiles, 1)
  assert.deepEqual(result.report.beforeClose, [{ schemaObjects: 0, transaction: false }])
  const database = setup.context.open(setup.path)
  assert.equal(database.prepare('SELECT count(*) AS count FROM sqlite_schema').get().count, 0)
})

test('cleanup refuses to remove a replacement belonging to another file owner', { timeout: 30000 }, t => {
  const setup = prepareContext(t)
  const result = runFailure(setup, 'replace')
  assert.match(result.stderr, /Database initialization failed:/)
  assert.match(result.stderr, /ERR_TEST_SCHEMA_READ/)
  assert.match(result.stderr, /ERR_DATABASE_CLEANUP_OWNERSHIP/)
  assert.equal(result.report.createdFiles, 1)
  assert.ok(result.report.replacement)
  const final = fingerprint(setup.path)
  assert.equal(final.hash, fingerprint(setup.protectedPath).hash)
  assert.equal(final.hash, result.report.replacement.hash)
  assert.equal(final.dev.toString(), result.report.replacement.dev)
  assert.equal(final.ino.toString(), result.report.replacement.ino)
  assert.equal(existsSync(setup.path + '.owned'), true)
  const database = setup.context.open(setup.path)
  assert.deepEqual(verifyDatabaseSchema(database), { tableCount: 11, columnCount: 45 })
  assert.equal(database.prepare('SELECT name FROM tags').get().name, 'Fixture tag')
})

test('unknown journal is preserved together with its incomplete database', { timeout: 30000 }, t => {
  const setup = prepareContext(t)
  const result = runFailure(setup, 'journal')
  assert.match(result.stderr, /Database initialization failed:/)
  assert.match(result.stderr, /ERR_TEST_SCHEMA_READ/)
  assert.match(result.stderr, /sidecar file exists/)
  assert.equal(result.report.createdFiles, 1)
  assert.equal(existsSync(setup.path), true)
  assert.equal(readFileSync(setup.path + '-journal', 'utf8'), 'Unknown journal bytes')
})

test('a close error after commit reports failure without deleting the completed database', { timeout: 30000 }, t => {
  const setup = prepareContext(t)
  const result = runFailure(setup, 'close')
  assert.match(result.stderr, /Database initialization failed:/)
  assert.match(result.stderr, /ERR_TEST_CLOSE/)
  assert.equal(result.report.createdFiles, 1)
  assert.equal(result.report.beforeClose.length, 1)
  assert.ok(result.report.beforeClose[0].schemaObjects > 0)
  assert.equal(result.report.beforeClose[0].transaction, false)
  const database = setup.context.open(setup.path)
  assert.deepEqual(verifyDatabaseSchema(database), { tableCount: 11, columnCount: 45 })
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
})

test('an existing database is protected before an injected schema failure can run', { timeout: 30000 }, t => {
  const setup = prepareContext(t)
  const result = runFailure(setup, 'read', setup.protectedPath)
  assert.match(result.stderr, /Database initialization refused:/)
  assert.doesNotMatch(result.stderr, /ERR_TEST_SCHEMA_READ/)
  assert.equal(result.report.schemaRead, false)
  assert.equal(result.report.createdFiles, 0)
  assert.deepEqual(result.report.beforeClose, [])
})
