import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveDatabasePath } from '../config/paths.js'
import { closeDatabase, openExistingDatabase } from './connection.js'
import { withTransaction } from './transaction.js'
import { verifyDatabaseSchema } from './schema-validation.js'

export function assertDatabaseDoesNotExist(databasePath) {
  const resolvedPath = resolveDatabasePath(databasePath)

  try {
    lstatSync(resolvedPath)
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Creation must still use exclusive access after this early guard.
      return resolvedPath
    }

    throw error
  }

  const error = new Error('Database initialization refused because the target already exists.')
  error.code = 'EEXIST'
  throw error
}

export function prepareDatabaseParentDirectory(databasePath) {
  const resolvedPath = assertDatabaseDoesNotExist(databasePath)
  mkdirSync(dirname(resolvedPath), { recursive: true })
  return resolvedPath
}

export function createDatabaseFile(databasePath) {
  const resolvedPath = prepareDatabaseParentDirectory(databasePath)
  // The initialization owner must keep and finally close this handle.
  const fileDescriptor = openSync(resolvedPath, 'wx', 0o600)
  return { databasePath: resolvedPath, fileDescriptor }
}

export function applyDatabaseSchema(database) {
  const schema = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8')

  withTransaction(database, connection => {
    // Check and apply under the same write lock to protect existing schemas.
    if (connection.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) {
      const error = new Error('Database initialization requires an empty schema.')
      error.code = 'EEXIST'
      throw error
    }

    connection.exec(schema)
    verifyDatabaseSchema(connection)
  })
}

function assertNoDatabaseSidecars(databasePath) {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try {
      lstatSync(databasePath + suffix)
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue
      }

      throw error
    }

    const error = new Error('Database initialization refused because a sidecar file exists.')
    error.code = 'EEXIST'
    throw error
  }
}

function assertDatabaseFileOwnership(databasePath, fileIdentity) {
  const currentFile = lstatSync(databasePath, { bigint: true })
  // Keep the original descriptor open so its inode cannot be reused here.
  if (!currentFile.isFile() || currentFile.nlink !== 1n || fileIdentity.ino === 0n ||
      currentFile.dev !== fileIdentity.dev || currentFile.ino !== fileIdentity.ino) {
    const error = new Error('Database cleanup refused because file ownership cannot be confirmed.')
    error.code = 'ERR_DATABASE_CLEANUP_OWNERSHIP'
    throw error
  }
}

function removeIncompleteDatabaseFile(createdFile, fileIdentity) {
  try {
    assertDatabaseFileOwnership(createdFile.databasePath, fileIdentity)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return
    }

    throw error
  }

  unlinkSync(createdFile.databasePath)
}

export function initializeDatabase(databasePath) {
  const createdFile = createDatabaseFile(databasePath)
  const errors = []
  let database
  let fileIdentity
  let openingAttempted = false
  let cleanupSafe = true
  let schemaApplied = false

  try {
    fileIdentity = fstatSync(createdFile.fileDescriptor, { bigint: true })
    // Existing sidecars may belong to another database and must not be opened.
    assertNoDatabaseSidecars(createdFile.databasePath)
    assertDatabaseFileOwnership(createdFile.databasePath, fileIdentity)
    openingAttempted = true

    try {
      database = openExistingDatabase(createdFile.databasePath)
    } catch (error) {
      // Opening aggregates can include a failed close of a private connection.
      if (error instanceof AggregateError) {
        cleanupSafe = false
      }

      throw error
    }

    assertDatabaseFileOwnership(createdFile.databasePath, fileIdentity)
    applyDatabaseSchema(database)
    schemaApplied = true
  } catch (error) {
    errors.push(error)
  } finally {
    // Release the SQLite connection before the exclusively created file handle.
    try {
      if (database) {
        closeDatabase(database)
      }
    } catch (error) {
      cleanupSafe = false
      errors.push(error)
    }

    try {
      if (!schemaApplied && cleanupSafe && fileIdentity) {
        // Unknown sidecars are preserved with their database for recovery.
        if (openingAttempted) {
          assertNoDatabaseSidecars(createdFile.databasePath)
        }

        removeIncompleteDatabaseFile(createdFile, fileIdentity)
      }
    } catch (error) {
      errors.push(error)
    }

    // A connection cleanup failure must not prevent file handle cleanup.
    try {
      closeSync(createdFile.fileDescriptor)
    } catch (error) {
      errors.push(error)
    }
  }

  if (errors.length === 1) {
    throw errors[0]
  }

  if (errors.length > 1) {
    throw new AggregateError(errors, 'Database initialization and resource cleanup failed.')
  }

  return { databasePath: createdFile.databasePath }
}
