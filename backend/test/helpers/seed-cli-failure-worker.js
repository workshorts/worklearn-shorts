import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'

// This preload belongs only to child-process tests and is never imported by the CLI.
const mode = process.env.TEST_SEED_CLI_FAILURE
const tracePath = process.env.TEST_SEED_CLI_TRACE
const trace = { closes: 0, openAfterClose: null, transactionBeforeClose: null }
const originalClose = DatabaseSync.prototype.close
const originalPrepare = DatabaseSync.prototype.prepare
let videoInsertCount = 0

DatabaseSync.prototype.close = function(...args) {
  trace.transactionBeforeClose = this.isTransaction
  const result = originalClose.apply(this, args)
  trace.closes += 1
  trace.openAfterClose = this.isOpen
  if (mode === 'close' || mode === 'write-close') {
    throw new Error(`Private close detail: ${process.env.ADMIN_PASSWORD} ${process.env.DB_PATH}`)
  }
  return result
}

if (mode === 'write-close') {
  DatabaseSync.prototype.prepare = function(sql, ...args) {
    const statement = originalPrepare.call(this, sql, ...args)
    if (sql.startsWith('INSERT INTO videos (')) {
      const originalRun = statement.run.bind(statement)
      statement.run = (...values) => {
        videoInsertCount += 1
        if (videoInsertCount === 4) {
          throw new Error(`Private write detail: ${process.env.ADMIN_USERNAME} ${process.env.ADMIN_PASSWORD} ${process.env.DB_PATH}`)
        }
        return originalRun(...values)
      }
    }
    return statement
  }
}

process.on('exit', () => writeFileSync(tracePath, JSON.stringify(trace)))
