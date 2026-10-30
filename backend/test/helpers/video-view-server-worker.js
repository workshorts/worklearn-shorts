import { writeSync } from 'node:fs'
import { app } from '../../src/app.js'
import { closeDb, getDb } from '../../src/db/client.js'

const database = getDb()
const exec = database.exec.bind(database)

// Observe real lock attempts without changing SQLite statements or their results.
database.exec = function(sql, ...args) {
  if (sql === 'BEGIN IMMEDIATE') writeSync(1, 'VIEW_BEGIN\n')
  return exec(sql, ...args)
}

const server = app.listen(0, '127.0.0.1', () => {
  writeSync(1, 'VIEW_READY=' + JSON.stringify({ port: server.address().port, pid: process.pid }) + '\n')
})

let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  server.closeAllConnections()
  server.close(() => {
    closeDb()
    if (process.connected) process.disconnect()
  })
}

process.on('message', message => { if (message === 'stop') stop() })
process.on('disconnect', stop)
