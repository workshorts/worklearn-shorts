import { types } from 'node:util'
import { closeDatabase } from './connection.js'

// Callbacks must perform synchronous DB work and leave transaction control here.
export function withTransaction(database, callback, { mode = 'IMMEDIATE' } = {}) {
  if (typeof callback !== 'function' || types.isAsyncFunction(callback) ||
      types.isGeneratorFunction(callback) ||
      Object.prototype.toString.call(callback) !== '[object Function]') {
    throw new TypeError('Transaction callbacks must be synchronous functions.')
  }

  if (mode !== 'IMMEDIATE' && mode !== 'DEFERRED') {
    throw new TypeError('Transaction mode must be IMMEDIATE or DEFERRED.')
  }

  if (!database.isOpen) {
    throw new Error('Database connection is closed.')
  }

  if (database.isTransaction) {
    throw new Error('Nested transactions are not supported.')
  }

  // A failed BEGIN must not roll back a transaction owned by another caller.
  database.exec(mode === 'IMMEDIATE' ? 'BEGIN IMMEDIATE' : 'BEGIN')
  let closeOnFailure = false

  try {
    const result = callback(database)

    if (result !== null && result !== undefined && typeof result.then === 'function') {
      closeOnFailure = true

      if (types.isPromise(result)) {
        // Observe rejection without allowing a later continuation to use this DB.
        Promise.prototype.catch.call(result, () => {})
      }

      throw new TypeError('Transaction callbacks must return synchronously.')
    }

    if (!database.isOpen || !database.isTransaction) {
      closeOnFailure = true
      throw new Error('Transaction callbacks must not close or end the transaction.')
    }

    database.exec('COMMIT')
    return result
  } catch (error) {
    const errors = [error]

    try {
      if (database.isOpen && database.isTransaction) {
        database.exec('ROLLBACK')
      }
    } catch (rollbackError) {
      errors.push(rollbackError)
      closeOnFailure = true
    }

    if (closeOnFailure) {
      try {
        closeDatabase(database)
      } catch (closeError) {
        errors.push(closeError)
      }
    }

    if (errors.length > 1) {
      throw new AggregateError(errors, 'Transaction failed and cleanup failed.')
    }

    throw error
  }
}
