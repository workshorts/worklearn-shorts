import assert from 'node:assert/strict'
import { existsSync, lstatSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
import { verifyDatabaseSchema } from '../../src/db/schema-validation.js'

function startWorker(context, path, gate, barrier) {
  const entry = fileURLToPath(new URL('../helpers/initialization-worker.js', import.meta.url))
  const environment = {
    ...process.env,
    DB_PATH: path,
    TEST_DB_INITIALIZATION_GATE: gate,
    TEST_DB_INITIALIZATION_BARRIER: barrier
  }
  delete environment.NODE_TEST_CONTEXT
  const child = spawn(process.execPath, [entry], {
    cwd: context.directory,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000,
    killSignal: 'SIGKILL',
    windowsHide: true
  })
  let stdout = ''
  let stderr = ''
  let failure
  let ready = false
  let resolveReady
  let rejectReady
  const prepared = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // A setup failure must not leave a readiness rejection unobserved.
  prepared.catch(() => {})

  child.stdout.on('data', data => {
    stdout += data

    if (!ready && stdout.split(/\r?\n/).includes('INITIALIZATION_READY')) {
      ready = true
      resolveReady()
    }
  })
  child.stderr.on('data', data => { stderr += data })
  child.on('error', error => {
    failure = error
    rejectReady(error)
  })
  const finished = new Promise(resolve => {
    child.once('close', (code, signal) => {
      if (!ready) {
        rejectReady(new Error(`Worker exited before its initialization barrier: ${stderr}`))
      }

      resolve({ code, signal, stdout, stderr, failure })
    })
  })

  context.addCleanup(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }

    await finished
  })

  return { pid: child.pid, prepared, finished }
}

for (const barrier of ['start', 'claim']) {
  const name = barrier === 'start'
    ? 'concurrent CLI initialization keeps exactly one complete database'
    : 'exclusive creation protects the winner after both processes pass the early guard'

  test(name, { timeout: 30000 }, async t => {
    const context = createDatabaseContext(t)
    const path = context.path('new', 'nested', 'app.db')
    const gate = context.path('release.gate')
    assert.equal(existsSync(path), false)
    const first = startWorker(context, path, gate, barrier)
    const second = startWorker(context, path, gate, barrier)
    assert.ok(first.pid && second.pid)
    assert.notEqual(first.pid, second.pid)

    await Promise.all([first.prepared, second.prepared])
    assert.equal(existsSync(path), false)
    writeFileSync(gate, 'release')
    const results = await Promise.all([first.finished, second.finished])

    for (const result of results) {
      assert.equal(result.failure, undefined, result.failure?.message)
      assert.equal(result.signal, null, result.stderr)
    }

    assert.deepEqual(results.map(result => result.code).sort(), [0, 1])
    const winner = results.find(result => result.code === 0)
    const loser = results.find(result => result.code === 1)
    assert.match(winner.stdout, /^Database initialized successfully\.$/m)
    assert.doesNotMatch(winner.stderr, /Database initialization (?:failed|refused):/)
    assert.match(loser.stderr, /Database initialization refused:/)
    assert.doesNotMatch(loser.stdout, /Database initialized successfully\.|CREATED_FILE=/)
    const identities = [...winner.stdout.matchAll(/^CREATED_FILE=(.+)$/gm)]
    assert.equal(identities.length, 1)
    const identity = JSON.parse(identities[0][1])
    const file = lstatSync(path, { bigint: true })
    assert.equal(file.isFile(), true)
    assert.equal(file.dev.toString(), identity.dev)
    assert.equal(file.ino.toString(), identity.ino)

    for (const suffix of ['-journal', '-wal', '-shm']) {
      assert.equal(existsSync(path + suffix), false)
    }

    const database = context.open(path)
    assert.deepEqual(verifyDatabaseSchema(database), { tableCount: 11, columnCount: 45 })
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
    const tables = database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*'"
    ).all()
    assert.equal(tables.length, 11)

    for (const { name } of tables) {
      assert.equal(database.prepare(`SELECT count(*) AS count FROM ${name}`).get().count, 0)
    }
  })
}
