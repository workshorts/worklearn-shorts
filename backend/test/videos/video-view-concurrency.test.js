import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { mkdirSync, readFileSync } from 'node:fs'
import http from 'node:http'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const visitorId = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function startWorker(context, databasePath, uploadDir) {
  const environment = { ...process.env, DB_PATH: databasePath, UPLOAD_DIR: uploadDir,
    AUTH_SECRET: 'test-secret-test-secret-1234', ALLOWED_ORIGIN: 'http://localhost:5173' }
  delete environment.NODE_TEST_CONTEXT
  const child = spawn(process.execPath,
    [fileURLToPath(new URL('../helpers/video-view-server-worker.js', import.meta.url))], {
      cwd: context.directory, env: environment, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 25000, killSignal: 'SIGKILL',
    })
  const events = new EventEmitter()
  let lines = ''
  let stderr = ''
  let begins = 0
  let failure
  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  ready.catch(() => {})
  const readyTimer = setTimeout(() => rejectReady(new Error('View server readiness timed out.')), 5000)
  child.stdout.on('data', chunk => {
    lines += chunk
    let newline
    while ((newline = lines.indexOf('\n')) !== -1) {
      const line = lines.slice(0, newline).trimEnd()
      lines = lines.slice(newline + 1)
      if (line.startsWith('VIEW_READY=')) {
        clearTimeout(readyTimer)
        resolveReady(JSON.parse(line.slice('VIEW_READY='.length)))
      }
      if (line === 'VIEW_BEGIN') { begins += 1; events.emit('begin') }
    }
  })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.on('error', error => { failure = error; rejectReady(error) })
  const finished = new Promise(resolve => {
    child.once('close', (code, signal) => {
      clearTimeout(readyTimer)
      rejectReady(new Error('View server exited before readiness: ' + stderr))
      resolve({ code, signal, failure, stderr })
    })
  })
  context.addCleanup(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await finished
  })
  return {
    ready, finished,
    get begins() { return begins },
    async waitForBegins(target) {
      while (begins < target) await once(events, 'begin', { signal: AbortSignal.timeout(2500) })
    },
    stop() { if (child.connected) child.send('stop') },
  }
}

function request(port, path, visitor) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path,
      method: visitor === undefined ? 'GET' : 'POST', agent: false,
      headers: visitor === undefined ? {} : { 'X-Visitor-Id': visitor } }, res => {
      const chunks = []
      res.on('error', reject)
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) }
        catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.setTimeout(8000, () => req.destroy(new Error('View request timed out.')))
    req.end()
  })
}

test('independent HTTP server processes count concurrent requests for the same normalized pair exactly once', { timeout: 30000 }, async t => {
  const context = createDatabaseContext(t)
  const databasePath = context.path('shared.db')
  context.initialize(databasePath)
  const database = context.open(databasePath)
  insertMinimalFixture(database)
  const uploadDir = context.path('uploads')
  mkdirSync(uploadDir)
  const targets = Array.from({ length: 3 }, (_, index) => database.prepare(
    'INSERT INTO videos (title, video_path) VALUES (?, ?)'
  ).run('Concurrent target ' + index, `videos/10000000-0000-4000-8000-00000000000${index}.mp4`).lastInsertRowid)
  const workers = [startWorker(context, databasePath, uploadDir), startWorker(context, databasePath, uploadDir)]
  const addresses = await Promise.all(workers.map(worker => worker.ready))
  assert.notEqual(addresses[0].pid, addresses[1].pid)
  assert.notEqual(addresses[0].pid, process.pid)
  assert.notEqual(addresses[1].pid, process.pid)
  assert.notEqual(addresses[0].port, addresses[1].port)

  function snapshot() {
    return {
      tables: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
      schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
      hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
    }
  }

  async function contend(id, expectedCount) {
    const expectedBegins = workers.map(worker => worker.begins + 1)
    database.exec('BEGIN IMMEDIATE')
    let responses
    try {
      // Keep both native SQLite writers waiting until each process has attempted BEGIN.
      responses = Promise.all(Array.from({ length: 12 }, (_, index) => request(
        addresses[index % 2].port, `/api/videos/${index % 3 === 0 ? '000' : ''}${id}/view`,
        index % 3 === 0 ? visitorId.toUpperCase() : visitorId,
      )))
      responses.catch(() => {})
      await Promise.race([
        Promise.all(workers.map((worker, index) => worker.waitForBegins(expectedBegins[index]))),
        responses.then(() => { throw new Error('Requests completed before the write lock was released.') }),
      ])
      assert.equal(database.isTransaction, true)
      workers.forEach((worker, index) => assert.equal(worker.begins, expectedBegins[index]))
      assert.equal(database.prepare('SELECT count(*) AS count FROM video_views WHERE video_id = ?').get(id).count, expectedCount)
    } finally {
      if (database.isTransaction) database.exec('ROLLBACK')
    }
    const results = await responses
    // Stdout and HTTP use separate pipes, so wait for all observations before comparing totals.
    await Promise.all(workers.map((worker, index) => worker.waitForBegins(expectedBegins[index] + 5)))
    workers.forEach((worker, index) => assert.equal(worker.begins, expectedBegins[index] + 5))
    return results
  }

  await t.test('three fresh pairs each produce one true and eleven false responses after both writers wait on the same lock', async () => {
    for (const id of targets) {
      const before = snapshot()
      const responses = await contend(id, 0)
      for (const response of responses) {
        assert.equal(response.status, 200)
        assert.equal(typeof response.json.counted, 'boolean')
        assert.deepEqual(response.json, { videoId: id, viewCount: 1, counted: response.json.counted })
      }
      assert.equal(responses.filter(response => response.json.counted === true).length, 1)
      assert.equal(responses.filter(response => response.json.counted === false).length, 11)
      const after = snapshot()
      const pair = row => row.video_id === id && row.visitor_id === visitorId
      assert.equal(after.tables.video_views.filter(pair).length, 1)
      assert.deepEqual(after.tables.video_views.filter(row => !pair(row)), before.tables.video_views)
      for (const table of tables.filter(table => table !== 'video_views')) {
        assert.deepEqual(after.tables[table], before.tables[table])
      }
      assert.deepEqual(after.schema, before.schema)
    }
  })

  await t.test('concurrent retries all return false and preserve the committed rows, timestamps and database file', async () => {
    const before = snapshot()
    for (const id of targets) {
      const responses = await contend(id, 1)
      for (const response of responses) {
        assert.deepEqual(response, { status: 200, json: { videoId: id, viewCount: 1, counted: false } })
      }
      assert.deepEqual(snapshot(), before)
    }
  })

  await t.test('both processes read the committed counts and exit cleanly without leaking write locks', async () => {
    const before = snapshot()
    for (const { port } of addresses) {
      for (const id of targets) {
        const response = await request(port, '/api/videos/' + id)
        assert.equal(response.status, 200)
        assert.equal(response.json.id, id)
        assert.equal(response.json.viewCount, 1)
      }
    }
    workers.forEach(worker => worker.stop())
    for (const result of await Promise.all(workers.map(worker => worker.finished))) {
      assert.equal(result.failure, undefined)
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.signal, null, result.stderr)
      assert.doesNotMatch(result.stderr, /INTERNAL_ERROR/)
    }
    database.exec('BEGIN IMMEDIATE')
    database.exec('ROLLBACK')
    assert.equal(database.isTransaction, false)
    assert.deepEqual(snapshot(), before)
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
  })
})
