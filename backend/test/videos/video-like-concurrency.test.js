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

const visitorA = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const visitorB = '12345678-abcd-4abc-9def-012345abcdef'
const visitorC = 'aabbccdd-eeff-4abc-8def-012345abcdee'
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function startWorker(context, databasePath, uploadDir) {
  const environment = { ...process.env, DB_PATH: databasePath, UPLOAD_DIR: uploadDir,
    AUTH_SECRET: 'test-secret-test-secret-1234', ALLOWED_ORIGIN: 'http://localhost:5173' }
  delete environment.NODE_TEST_CONTEXT
  // The existing worker runs the real app and observes every BEGIN IMMEDIATE.
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
  const readyTimer = setTimeout(() => rejectReady(new Error('Like server readiness timed out.')), 5000)
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
      rejectReady(new Error('Like server exited before readiness: ' + stderr))
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

function request(port, path, method = 'GET', visitorId = visitorA) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: false,
      headers: visitorId === null ? {} : { 'X-Visitor-Id': visitorId } }, res => {
      const chunks = []
      res.on('error', reject)
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) }
        catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.setTimeout(8000, () => req.destroy(new Error('Like request timed out.')))
    req.end()
  })
}

test('independent HTTP processes serialize like mutations and expose their final state consistently through paged lists and details', { timeout: 30000 }, async t => {
  const context = createDatabaseContext(t)
  const databasePath = context.path('shared-likes.db')
  context.initialize(databasePath)
  const database = context.open(databasePath)
  const fixture = insertMinimalFixture(database)
  database.prepare('UPDATE videos SET video_path = ? WHERE id = ?')
    .run('videos/30000000-0000-4000-8000-000000000001.mp4', fixture.videoId)
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
    .run(4, 'Never liked control', 'videos/30000000-0000-4000-8000-000000000004.webm')
  const uploadDir = context.path('uploads')
  mkdirSync(uploadDir)
  const targets = [2, 3, Number.MAX_SAFE_INTEGER]
  for (const [index, id] of targets.entries()) {
    database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
      .run(id, 'Concurrent like target ' + index, `videos/10000000-0000-4000-8000-00000000000${index}.mp4`)
    database.prepare('INSERT INTO video_likes (video_id, visitor_id, created_at) VALUES (?, ?, ?)')
      .run(id, visitorB, '2001-02-03T04:05:06.000Z')
    database.prepare('INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)').run(id, visitorA)
  }
  const workers = [startWorker(context, databasePath, uploadDir), startWorker(context, databasePath, uploadDir)]
  const addresses = await Promise.all(workers.map(worker => worker.ready))
  assert.notEqual(addresses[0].pid, addresses[1].pid)
  assert.notEqual(addresses[0].pid, process.pid)
  assert.notEqual(addresses[1].pid, process.pid)
  assert.notEqual(addresses[0].port, addresses[1].port)

  function snapshot() {
    return {
      rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
      schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
      hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
    }
  }

  function readState(id) {
    const rows = database.prepare('SELECT visitor_id FROM video_likes WHERE video_id = ?').all(id)
    const own = rows.filter(row => row.visitor_id === visitorA).length
    assert.ok(own === 0 || own === 1)
    assert.equal(rows.filter(row => row.visitor_id === visitorB).length, 1)
    assert.equal(rows.length, own + 1)
    return { count: rows.length, liked: own === 1 }
  }

  function assertUnrelatedPreserved(before, id) {
    const after = snapshot()
    for (const table of tables.filter(table => table !== 'video_likes')) {
      assert.deepEqual(after.rows[table], before.rows[table])
    }
    const other = row => !(row.video_id === id && row.visitor_id === visitorA)
    assert.deepEqual(after.rows.video_likes.filter(other), before.rows.video_likes.filter(other))
    assert.deepEqual(after.schema, before.schema)
  }

  async function assertFinalReads(id) {
    const expected = readState(id)
    const before = snapshot()
    for (const { port } of addresses) {
      const response = await request(port, '/api/videos/' + id)
      assert.equal(response.status, 200)
      assert.equal(response.json.id, id)
      assert.equal(response.json.likeCount, expected.count)
      assert.equal(response.json.likedByMe, expected.liked)
    }
    assert.deepEqual(snapshot(), before)
    return expected
  }

  async function assertPagedFinalReads() {
    // Read only after all writers finish; response arrival order does not identify the last commit.
    const before = snapshot()
    const begins = workers.map(worker => worker.begins)
    const ids = database.prepare('SELECT id FROM videos ORDER BY id DESC').all().map(row => row.id)
    assert.deepEqual(ids, [Number.MAX_SAFE_INTEGER, 4, 3, 2, fixture.videoId])
    const expected = new Map(ids.map(id => [id, before.rows.video_likes.filter(row => row.video_id === id)]))
    const commonVideos = new Map()
    for (const { port } of addresses) {
      for (const visitor of [visitorA.toUpperCase(), visitorB, visitorC, null]) {
        const normalized = visitor?.toLowerCase() ?? null
        const collected = []
        for (let page = 1; page <= 4; page += 1) {
          const response = await request(port, `/api/videos?page=${page}&limit=2`, 'GET', visitor)
          assert.equal(response.status, 200)
          assert.deepEqual(Object.keys(response.json).sort(), ['data', 'limit', 'page', 'total'])
          assert.equal(response.json.page, page)
          assert.equal(response.json.limit, 2)
          assert.equal(response.json.total, ids.length)
          assert.deepEqual(response.json.data.map(video => video.id), ids.slice((page - 1) * 2, page * 2))
          collected.push(...response.json.data)
        }
        assert.deepEqual(collected.map(video => video.id), ids)
        for (const video of collected) {
          const rows = expected.get(video.id)
          assert.equal(video.likeCount, rows.length)
          assert.equal(video.likedByMe, normalized !== null && rows.some(row => row.visitor_id === normalized))
          const detail = await request(port, '/api/videos/000' + video.id, 'GET', visitor)
          assert.equal(detail.status, 200)
          assert.deepEqual(detail.json, video)
          // Switching visitors can change only the personalized field, not the shared Video representation.
          const { likedByMe, ...common } = video
          if (commonVideos.has(video.id)) assert.deepEqual(common, commonVideos.get(video.id))
          else commonVideos.set(video.id, common)
        }
      }
    }
    assert.deepEqual(snapshot(), before)
    workers.forEach((worker, index) => assert.equal(worker.begins, begins[index]))
    assert.equal(database.isTransaction, false)
  }

  async function contend(id, methods) {
    const expectedBegins = workers.map(worker => worker.begins + 1)
    const beforeState = readState(id)
    database.exec('BEGIN IMMEDIATE')
    let responses
    try {
      responses = Promise.all(methods.map((method, index) => request(addresses[index % 2].port,
        `/api/videos/${index % 3 === 0 ? '000' : ''}${id}/like`, method,
        index % 3 === 0 ? visitorA.toUpperCase() : visitorA,
      ).then(response => ({ method, response }))))
      responses.catch(() => {})
      // Release only after both real writers have attempted to obtain the parent's lock.
      await Promise.race([
        Promise.all(workers.map((worker, index) => worker.waitForBegins(expectedBegins[index]))),
        responses.then(() => { throw new Error('Requests completed before the write lock was released.') }),
      ])
      assert.equal(database.isTransaction, true)
      workers.forEach((worker, index) => assert.equal(worker.begins, expectedBegins[index]))
      assert.deepEqual(readState(id), beforeState)
    } finally {
      if (database.isTransaction) database.exec('ROLLBACK')
    }
    const results = await responses
    await Promise.all(workers.map((worker, index) => worker.waitForBegins(expectedBegins[index] + 5)))
    workers.forEach((worker, index) => assert.equal(worker.begins, expectedBegins[index] + 5))
    for (const { method, response } of results) {
      // Only A changes; B contributes one fixed like, so each method has an exact own-transaction result.
      assert.deepEqual(response, { status: 200, json: {
        videoId: id, likeCount: method === 'PUT' ? 2 : 1, likedByMe: method === 'PUT',
      } })
    }
    return assertFinalReads(id)
  }

  await t.test('concurrent PUTs create one pair and concurrent duplicate PUTs preserve its row and timestamp', async () => {
    for (const id of targets) {
      const before = snapshot()
      assert.deepEqual(await contend(id, Array(12).fill('PUT')), { count: 2, liked: true })
      assertUnrelatedPreserved(before, id)
      const saved = snapshot()
      assert.deepEqual(await contend(id, Array(12).fill('PUT')), { count: 2, liked: true })
      assert.deepEqual(snapshot(), saved)
    }
  })

  await t.test('concurrent DELETEs remove one pair and concurrent absent-pair DELETEs preserve the database file', async () => {
    for (const id of targets) {
      const before = snapshot()
      assert.deepEqual(await contend(id, Array(12).fill('DELETE')), { count: 1, liked: false })
      assertUnrelatedPreserved(before, id)
      const saved = snapshot()
      assert.deepEqual(await contend(id, Array(12).fill('DELETE')), { count: 1, liked: false })
      assert.deepEqual(snapshot(), saved)
    }
  })

  await t.test('mixed PUT and DELETE writers return exact operation results and converge to a valid observable final state', async () => {
    for (const id of targets) {
      for (let round = 0; round < 2; round += 1) {
        const before = snapshot()
        const methods = Array.from({ length: 12 }, (_, index) => (index + round) % 2 === 0 ? 'PUT' : 'DELETE')
        const state = await contend(id, methods)
        assert.ok(state.count === 1 || state.count === 2)
        assert.equal(state.liked, state.count === 2)
        assertUnrelatedPreserved(before, id)
      }
    }
  })

  await t.test('after all competing writers finish every page and detail matches the final database for both visitors, a new visitor and anonymous readers', async () => {
    await assertPagedFinalReads()
  })

  await t.test('an ordered cancellation and addition after all competing requests produce deterministic final states', async () => {
    for (const id of targets) {
      const before = snapshot()
      assert.deepEqual(await request(addresses[0].port, `/api/videos/${id}/like`, 'DELETE'),
        { status: 200, json: { videoId: id, likeCount: 1, likedByMe: false } })
      assert.deepEqual(await assertFinalReads(id), { count: 1, liked: false })
      assertUnrelatedPreserved(before, id)
    }
    await assertPagedFinalReads()
    for (const id of targets) {
      const before = snapshot()
      assert.deepEqual(await request(addresses[1].port, `/api/videos/${id}/like`, 'PUT'),
        { status: 200, json: { videoId: id, likeCount: 2, likedByMe: true } })
      assert.deepEqual(await assertFinalReads(id), { count: 2, liked: true })
      assertUnrelatedPreserved(before, id)
    }
    await Promise.all(workers.map(worker => worker.waitForBegins(111)))
    workers.forEach(worker => assert.equal(worker.begins, 111))
  })

  await t.test('reloading pages and details after ordered changes refreshes counts and personal flags without rewriting the database', async () => {
    for (const id of targets) assert.deepEqual(readState(id), { count: 2, liked: true })
    await assertPagedFinalReads()
  })

  await t.test('both processes exit cleanly without errors or leaked locks and the database remains consistent', async () => {
    const before = snapshot()
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
