import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { closeDatabase, openExistingDatabase } from '../../src/db/connection.js'
import { initializeDatabase } from '../../src/db/initialization.js'

function isWithin(directory, path) {
  const difference = relative(directory, path)
  return difference !== '' && difference !== '..' &&
    !difference.startsWith('../') && !difference.startsWith('..\\') && !isAbsolute(difference)
}

function assertNoLinks(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const stat = lstatSync(path)

    if (stat.isSymbolicLink()) {
      throw new Error('Test cleanup refused because the workspace contains a symbolic link.')
    }

    if (stat.isDirectory()) {
      assertNoLinks(path)
    }
  }
}

export function createDatabaseContext(testContext) {
  if (typeof testContext?.after !== 'function') {
    throw new TypeError('A test context with an after hook is required.')
  }

  const temporaryDirectory = realpathSync(tmpdir())
  const directory = mkdtempSync(join(temporaryDirectory, 'worklearn-db-test-'))
  const databases = new Set()
  const cleanupCallbacks = []
  let identity
  let active = true
  let cleanupPromise

  // Register before initialization so setup failures also release owned resources.
  testContext.after(() => cleanup())
  identity = lstatSync(directory, { bigint: true })

  function assertDirectoryOwnership() {
    const current = lstatSync(directory, { bigint: true })

    if (!isWithin(temporaryDirectory, directory) || current.isSymbolicLink() ||
        !current.isDirectory() || !identity || identity.ino === 0n ||
        current.dev !== identity.dev || current.ino !== identity.ino ||
        realpathSync(directory) !== directory) {
      throw new Error('Test workspace ownership cannot be confirmed.')
    }
  }

  function assertOwnedPath(path) {
    if (typeof path !== 'string' || !isAbsolute(path) || !isWithin(directory, resolve(path))) {
      throw new TypeError('An explicit path inside this test workspace is required.')
    }

    assertDirectoryOwnership()
    let current = resolve(path)

    while (relative(directory, current) !== '') {
      try {
        if (lstatSync(current).isSymbolicLink()) {
          throw new Error('Test paths must not traverse symbolic links.')
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error
        }
      }

      current = dirname(current)
    }

    return resolve(path)
  }

  function assertActive() {
    if (!active) {
      throw new Error('Test workspace cleanup has already started.')
    }
  }

  async function dispose() {
    active = false
    const errors = []

    // Stop registered processes or servers before closing their DB connections.
    for (let index = cleanupCallbacks.length - 1; index >= 0; index -= 1) {
      try {
        await cleanupCallbacks[index]()
        cleanupCallbacks.splice(index, 1)
      } catch (error) {
        errors.push(error)
      }
    }

    for (const database of databases) {
      try {
        closeDatabase(database)
        databases.delete(database)
      } catch (error) {
        errors.push(error)
      }
    }

    // Retain the directory whenever resource shutdown could not be confirmed.
    if (errors.length === 0) {
      try {
        assertDirectoryOwnership()
        assertNoLinks(directory)
        rmSync(directory, { recursive: true })
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length === 1) {
      throw errors[0]
    }

    if (errors.length > 1) {
      throw new AggregateError(errors, 'Test resource cleanup failed.')
    }
  }

  function cleanup() {
    if (!cleanupPromise) {
      cleanupPromise = dispose().catch(error => {
        cleanupPromise = undefined
        throw error
      })
    }

    return cleanupPromise
  }

  return {
    directory,
    path(...segments) {
      assertActive()
      return assertOwnedPath(resolve(directory, ...segments))
    },
    initialize(path) {
      assertActive()
      return initializeDatabase(assertOwnedPath(path))
    },
    open(path) {
      assertActive()
      const database = openExistingDatabase(assertOwnedPath(path))
      databases.add(database)
      return database
    },
    addCleanup(callback) {
      assertActive()

      if (typeof callback !== 'function') {
        throw new TypeError('A cleanup callback is required.')
      }

      cleanupCallbacks.push(callback)
    },
    cleanup
  }
}
