import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

const mode = process.env.TEST_DB_INITIALIZATION_FAILURE
const databasePath = process.env.DB_PATH
const protectedPath = process.env.TEST_DB_PROTECTED_PATH
const original = {
  openSync: fs.openSync,
  readFileSync: fs.readFileSync,
  unlinkSync: fs.unlinkSync,
  open: DatabaseSync.prototype.open,
  close: DatabaseSync.prototype.close,
  exec: DatabaseSync.prototype.exec
}
const descriptors = []
const databases = []
const beforeClose = []
let schemaRead = false
let replacement

function injectedError(message, code) {
  return Object.assign(new Error(message), { code })
}

fs.openSync = function(path, flags, ...args) {
  const descriptor = original.openSync.call(this, path, flags, ...args)

  if (path === databasePath && flags === 'wx') {
    descriptors.push(descriptor)
  }

  return descriptor
}
fs.readFileSync = function(path, ...args) {
  if (!(path instanceof URL) || !path.pathname.endsWith('/db/schema.sql')) {
    return original.readFileSync.call(this, path, ...args)
  }

  schemaRead = true

  if (['read', 'unlink', 'replace', 'journal'].includes(mode)) {
    if (mode === 'journal') {
      fs.writeFileSync(databasePath + '-journal', 'Unknown journal bytes')
    }

    throw injectedError('Injected schema read failure.', 'ERR_TEST_SCHEMA_READ')
  }

  const schema = original.readFileSync.call(this, path, ...args)

  if (mode === 'ddl') {
    return schema.replace('CREATE TABLE videos (', 'INVALID SQL;\nCREATE TABLE videos (')
  }

  if (mode === 'validation') {
    return schema + '\nCREATE TABLE unexpected_for_test (id INTEGER);'
  }

  return schema
}
fs.unlinkSync = function(path) {
  if (mode === 'unlink' && path === databasePath) {
    throw injectedError('Injected file removal failure.', 'EACCES')
  }

  return original.unlinkSync.call(this, path)
}
DatabaseSync.prototype.open = function(...args) {
  databases.push(this)
  return original.open.apply(this, args)
}
DatabaseSync.prototype.exec = function(sql, ...args) {
  if (mode === 'commit' && sql === 'COMMIT') {
    throw injectedError('Injected commit failure.', 'ERR_TEST_COMMIT')
  }

  return original.exec.call(this, sql, ...args)
}
DatabaseSync.prototype.close = function(...args) {
  // Observe rollback before releasing the handle; do not read an unknown journal.
  beforeClose.push({
    schemaObjects: mode === 'journal' ? null : this.prepare('SELECT count(*) AS count FROM sqlite_schema').get().count,
    transaction: this.isTransaction
  })
  const result = original.close.apply(this, args)

  if (mode === 'replace') {
    fs.renameSync(databasePath, databasePath + '.owned')
    fs.copyFileSync(protectedPath, databasePath)
    const stat = fs.lstatSync(databasePath, { bigint: true })
    replacement = {
      hash: createHash('sha256').update(original.readFileSync(databasePath)).digest('hex'),
      dev: stat.dev.toString(), ino: stat.ino.toString()
    }
  }

  if (mode === 'close') {
    throw injectedError('Injected connection close failure.', 'ERR_TEST_CLOSE')
  }

  return result
}
syncBuiltinESMExports()

try {
  await import('../../db/init.js')
} finally {
  // Restore builtins before reporting, even though this worker exits afterwards.
  for (const key of ['openSync', 'readFileSync', 'unlinkSync']) {
    fs[key] = original[key]
  }

  for (const key of ['open', 'close', 'exec']) {
    DatabaseSync.prototype[key] = original[key]
  }

  syncBuiltinESMExports()
}

console.log('FAILURE_REPORT=' + JSON.stringify({
  schemaRead,
  createdFiles: descriptors.length,
  descriptorsClosed: descriptors.every(descriptor => {
    try {
      fs.fstatSync(descriptor)
      return false
    } catch (error) {
      if (error.code !== 'EBADF') throw error
      return true
    }
  }),
  connectionsClosed: databases.every(database => !database.isOpen),
  beforeClose,
  replacement
}))
