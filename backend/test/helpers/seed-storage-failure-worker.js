import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'

// Preload only in isolated CLI tests; product code never imports this module.
const mode = process.env.TEST_SEED_STORAGE_FAILURE
const tracePath = process.env.TEST_SEED_STORAGE_TRACE
const prepare = DatabaseSync.prototype.prepare
const exec = DatabaseSync.prototype.exec
const close = DatabaseSync.prototype.close
const trace = { writeBegins: 0, writeCommits: 0, writeRollbacks: 0, closeCalls: 0,
  closed: null, transactionBeforeClose: null, failureCounts: null, errorCode: null, sqliteCode: null }
const inserts = { admins: 0, tags: 0, videos: 0, video_tags: 0 }
let writing = false

function recordFailure(database, error) {
  if (trace.failureCounts !== null) return
  trace.failureCounts = Object.keys(inserts).map(table =>
    prepare.call(database, `SELECT count(*) AS count FROM ${table}`).get().count)
  trace.errorCode = error.code ?? null
  trace.sqliteCode = error.errcode ?? null
}

DatabaseSync.prototype.exec = function(sql, ...args) {
  try {
    const result = exec.call(this, sql, ...args)
    if (sql === 'BEGIN IMMEDIATE') { writing = true; trace.writeBegins += 1 }
    if (sql === 'COMMIT' && writing) { writing = false; trace.writeCommits += 1 }
    if (sql === 'ROLLBACK' && writing) { writing = false; trace.writeRollbacks += 1 }
    return result
  } catch (error) {
    if (writing) recordFailure(this, error)
    throw error
  }
}

DatabaseSync.prototype.prepare = function(sql, ...args) {
  const statement = prepare.call(this, sql, ...args)
  const table = Object.keys(inserts).find(name => sql.startsWith(`INSERT INTO ${name} (`))
  if (!table) return statement
  const run = statement.run.bind(statement)
  statement.run = (...values) => {
    inserts[table] += 1
    try {
      if (mode === 'tags' && table === 'tags' && inserts[table] === 3) {
        prepare.call(this, 'INSERT INTO tags (name) VALUES (?)').run('Fixture tag')
      }
      if (mode === 'videos' && table === 'videos' && inserts[table] === 4) {
        exec.call(this, 'PRAGMA query_only = ON')
      }
      if (mode === 'links' && table === 'video_tags' && inserts[table] === 6) {
        prepare.call(this, 'INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(-1, -1)
      }
      return run(...values)
    } catch (error) {
      recordFailure(this, error)
      throw error
    }
  }
  return statement
}

DatabaseSync.prototype.close = function(...args) {
  trace.transactionBeforeClose = this.isTransaction
  const result = close.apply(this, args)
  trace.closeCalls += 1
  trace.closed = !this.isOpen
  return result
}

process.on('exit', () => writeFileSync(tracePath, JSON.stringify(trace)))
