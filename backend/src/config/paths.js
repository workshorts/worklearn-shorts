import './env.js'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const backendDirectory = fileURLToPath(new URL('../../', import.meta.url))

export function resolveDatabasePath(databasePath = process.env.DB_PATH ?? './data/app.db') {
  if (typeof databasePath !== 'string' || databasePath.trim() === '' || databasePath.includes('\0')) {
    throw new TypeError('DB_PATH must be a non-empty file system path.')
  }

  if (databasePath === ':memory:' || /^file:/i.test(databasePath)) {
    throw new TypeError('DB_PATH must be a file system path, not a SQLite URI or memory database.')
  }

  // Drive-relative paths depend on Windows per-drive working directories.
  if (process.platform === 'win32' && /^[a-z]:(?![\\/])/i.test(databasePath)) {
    throw new TypeError('DB_PATH must not use a drive-relative path.')
  }

  return resolve(backendDirectory, databasePath)
}
