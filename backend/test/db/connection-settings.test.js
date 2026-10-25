import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
import { closeDatabase } from '../../src/db/connection.js'

const expectedSettings = { foreignKeys: 1, busyTimeout: 5000, inTransaction: false }

function readSettings(database) {
  return {
    foreignKeys: database.prepare('PRAGMA foreign_keys').get().foreign_keys,
    busyTimeout: database.prepare('PRAGMA busy_timeout').get().timeout,
    inTransaction: database.isTransaction
  }
}

test('every new connection enables foreign keys and a five-second lock timeout before transactions', { timeout: 10000 }, t => {
  const context = createDatabaseContext(t)
  const path = context.path('settings.db')
  context.initialize(path)
  const connections = Array.from({ length: 3 }, () => context.open(path))
  assert.equal(new Set(connections).size, 3)

  for (const database of connections) {
    assert.equal(database.isOpen, true)
    assert.deepEqual(readSettings(database), expectedSettings)
  }
})

test('connection settings are isolated and restored when a connection is reopened', { timeout: 10000 }, t => {
  const context = createDatabaseContext(t)
  const path = context.path('settings.db')
  context.initialize(path)
  const changed = context.open(path)
  const existing = context.open(path)
  assert.deepEqual(readSettings(changed), expectedSettings)
  assert.deepEqual(readSettings(existing), expectedSettings)

  // Alter only the old connection; new connections must configure themselves.
  changed.exec('PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 17')
  assert.deepEqual(readSettings(changed), { foreignKeys: 0, busyTimeout: 17, inTransaction: false })
  assert.deepEqual(readSettings(existing), expectedSettings)
  const added = context.open(path)
  assert.deepEqual(readSettings(added), expectedSettings)
  assert.deepEqual(readSettings(changed), { foreignKeys: 0, busyTimeout: 17, inTransaction: false })

  closeDatabase(changed)
  assert.equal(changed.isOpen, false)
  const reopened = context.open(path)
  assert.notEqual(reopened, changed)
  assert.deepEqual(readSettings(reopened), expectedSettings)
  assert.deepEqual(readSettings(existing), expectedSettings)
  assert.deepEqual(readSettings(added), expectedSettings)
})

test('shared opening overrides incorrect native defaults on every connection', { timeout: 30000 }, t => {
  const context = createDatabaseContext(t)
  const path = context.path('native-defaults.db')
  context.initialize(path)
  const connectionUrl = new URL('../../src/db/connection.js', import.meta.url).href
  const code = [
    "import { DatabaseSync } from 'node:sqlite'",
    `import { openExistingDatabase, closeDatabase } from ${JSON.stringify(connectionUrl)}`,
    'const originalOpen = DatabaseSync.prototype.open',
    'const connections = []',
    'const initial = []',
    'const returned = []',
    'function readSettings(database) {',
    "  return { foreignKeys: database.prepare('PRAGMA foreign_keys').get().foreign_keys,",
    "    busyTimeout: database.prepare('PRAGMA busy_timeout').get().timeout, inTransaction: database.isTransaction }",
    '}',
    'DatabaseSync.prototype.open = function(...args) {',
    '  connections.push(this)',
    '  const result = originalOpen.apply(this, args)',
    "  this.exec('PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 17')",
    '  initial.push(readSettings(this))',
    '  return result',
    '}',
    'try {',
    '  for (let index = 0; index < 2; index += 1) {',
    '    returned.push(readSettings(openExistingDatabase(process.env.DB_PATH)))',
    '  }',
    '} finally {',
    '  try { for (const connection of connections) closeDatabase(connection) }',
    '  finally { DatabaseSync.prototype.open = originalOpen }',
    '}',
    'console.log(JSON.stringify({ initial, returned, closed: connections.every(connection => !connection.isOpen) }))'
  ].join('\n')
  const environment = { ...process.env, DB_PATH: path }
  delete environment.NODE_TEST_CONTEXT
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: context.directory,
    env: environment,
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true
  })
  assert.equal(child.error, undefined, child.error?.message)
  assert.equal(child.signal, null, child.stderr)
  assert.equal(child.status, 0, child.stderr)
  const result = JSON.parse(child.stdout)
  assert.deepEqual(result.initial, Array.from({ length: 2 }, () => ({
    foreignKeys: 0, busyTimeout: 17, inTransaction: false
  })))
  assert.deepEqual(result.returned, [expectedSettings, expectedSettings])
  assert.equal(result.closed, true)
})
