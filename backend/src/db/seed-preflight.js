import { closeDatabase, openExistingDatabase } from './connection.js'
import { verifyDatabaseSchema } from './schema-validation.js'
import { withTransaction } from './transaction.js'

// Reuse inside the final seed transaction before performing any writes.
export function verifySeedDatabase(database) {
  const schema = verifyDatabaseSchema(database)
  const checks = database.prepare('PRAGMA quick_check').all()

  if (checks.length !== 1 || checks[0].quick_check !== 'ok') {
    const error = new Error('Database integrity verification failed before seeding.')
    error.code = 'INVALID_DATABASE_INTEGRITY'
    throw error
  }

  return schema
}

// The caller owns a successful connection and must close it after seeding.
export function openSeedDatabase(databasePath) {
  const database = openExistingDatabase(databasePath)

  try {
    // Keep schema and integrity reads in one snapshot without taking a write lock.
    withTransaction(database, verifySeedDatabase, { mode: 'DEFERRED' })
    return database
  } catch (error) {
    try {
      closeDatabase(database)
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Seed preflight and cleanup failed.')
    }

    throw error
  }
}
