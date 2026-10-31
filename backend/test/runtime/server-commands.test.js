import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { hashPassword } from '../../src/lib/password.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const backend = fileURLToPath(new URL('../../', import.meta.url))
const visitor = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const password = 'RuntimeTest1234!'
const origin = 'http://localhost:5173'
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function bounded(promise, milliseconds, message) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds)
  })]).finally(() => clearTimeout(timer))
}

async function availablePort(port = 0) {
  const server = net.createServer()
  await new Promise((resolveReady, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolveReady)
  })
  const selected = server.address().port
  await new Promise((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()))
  return selected
}

function startCommand(context, script, databasePath, uploadDir, port) {
  const npm = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(path => path && existsSync(path))
  assert.ok(npm, 'The npm CLI is required to execute the actual package scripts.')
  const environment = { ...process.env, PORT: String(port), DB_PATH: databasePath, UPLOAD_DIR: uploadDir,
    AUTH_SECRET: 'runtime-test-secret-1234567890', ALLOWED_ORIGIN: origin, COOKIE_SECURE: 'false',
    ADMIN_SESSION_HOURS: '1', LOGIN_MAX_FAILS: '100', LOGIN_WINDOW_MINUTES: '15' }
  delete environment.NODE_TEST_CONTEXT
  const child = spawn(process.execPath, [npm, '--silent', 'run', script], {
    cwd: backend, env: environment, windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let failure
  let resolveReady
  let rejectReady
  const ready = new Promise((resolveStarted, rejectStarted) => { resolveReady = resolveStarted; rejectReady = rejectStarted })
  ready.catch(() => {})
  child.stdout.on('data', chunk => {
    stdout += chunk
    if (stdout.split(/\r?\n/).includes('Server running on http://localhost:' + port)) resolveReady()
  })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.on('error', error => { failure = error; rejectReady(error) })
  const finished = new Promise(resolveFinished => child.once('close', (code, signal) => {
    rejectReady(new Error('The package command exited before server readiness: ' + stderr))
    resolveFinished({ code, signal, failure, stdout, stderr })
  }))
  let stopping
  function stop() {
    if (!stopping) stopping = (async () => {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        if (process.platform === 'win32') {
          // Stop only this owned npm process tree, including the dev watcher and its server child.
          await new Promise((resolveStopped, rejectStopped) => execFile('taskkill.exe',
            ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, error => {
              if (error && child.exitCode === null && child.signalCode === null) rejectStopped(error)
              else resolveStopped()
            }))
        } else {
          process.kill(-child.pid, 'SIGTERM')
        }
      }
      return bounded(finished, 5000, 'The owned package process did not stop.')
    })()
    return stopping
  }
  context.addCleanup(stop)
  return { ready: bounded(ready, 8000, 'The package server did not become ready.'), stop,
    get running() { return child.exitCode === null && child.signalCode === null },
  }
}

function request(port, path, { method = 'GET', body, cookie } = {}) {
  return new Promise((resolveResponse, reject) => {
    const headers = { Connection: 'close', 'X-Visitor-Id': visitor, Origin: origin }
    if (cookie) headers.Cookie = cookie
    const payload = body === undefined ? undefined : JSON.stringify(body)
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(payload)
    }
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = []
      res.on('error', reject)
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch {}
        resolveResponse({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(new Error('Runtime HTTP request timed out.')))
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

test('the unchanged npm start and dev commands serve public and existing routes using isolated resources', { timeout: 45000 }, async t => {
  const scripts = JSON.parse(readFileSync(join(backend, 'package.json'), 'utf8')).scripts
  assert.equal(scripts.start, 'node src/server.js')
  assert.equal(scripts.dev, 'node --watch src/server.js')
  const context = createDatabaseContext(t)
  const databasePath = context.path('runtime.db')
  const uploadDir = context.path('uploads')
  context.initialize(databasePath)
  const database = context.open(databasePath)
  const fixture = insertMinimalFixture(database)
  database.prepare('UPDATE videos SET video_path = ? WHERE id = ?')
    .run('videos/10000000-0000-4000-8000-000000000001.mp4', fixture.videoId)
  database.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(password), fixture.adminId)

  function snapshot() {
    return {
      rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
      schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
      hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
    }
  }

  for (const script of ['start', 'dev']) {
    await t.test(`npm run ${script} starts the real entry point and preserves routes and committed data across process shutdown`, async () => {
      const port = await availablePort()
      const command = startCommand(context, script, databasePath, uploadDir, port)
      let beforeStop
      let calls = 0
      async function call(path, status = 200, options) {
        const response = await request(port, path, options)
        assert.equal(response.status, status, path)
        calls += 1
        return response
      }
      try {
        await command.ready
        assert.equal(command.running, true)
        for (const name of ['videos', 'thumbnails']) assert.equal(statSync(join(uploadDir, name)).isDirectory(), true)
        assert.deepEqual((await call('/api/tags')).json, { data: [{ id: fixture.tagId, name: 'Fixture tag' }] })
        const list = await call('/api/videos?tagId=' + fixture.tagId)
        assert.equal(list.json.total, 1)
        assert.deepEqual(list.json.data.map(video => video.id), [fixture.videoId])
        assert.deepEqual((await call('/api/videos/' + fixture.videoId)).json, list.json.data[0])
        assert.deepEqual((await call(`/api/videos/${fixture.videoId}/view`, 200, { method: 'POST' })).json,
          { videoId: fixture.videoId, viewCount: 2, counted: script === 'start' })
        assert.deepEqual((await call(`/api/videos/${fixture.videoId}/like`, 200, { method: 'PUT' })).json,
          { videoId: fixture.videoId, likeCount: 2, likedByMe: true })
        assert.deepEqual((await call(`/api/videos/${fixture.videoId}/like`, 200, { method: 'DELETE' })).json,
          { videoId: fixture.videoId, likeCount: 1, likedByMe: false })
        const courses = await call('/api/courses')
        assert.equal(courses.json.total, 1)
        assert.equal(courses.json.data[0].id, fixture.courseId)
        const course = await call('/api/courses/' + fixture.courseId)
        assert.deepEqual(course.json.videos.map(video => [video.id, video.sortOrder]), [[fixture.videoId, 1]])
        assert.equal((await call('/api/admin/me', 401)).json.code, 'AUTH_REQUIRED')
        assert.equal((await call('/api/admin/videos', 401)).json.code, 'AUTH_REQUIRED')
        const login = await call('/api/admin/login', 200, { method: 'POST', body: { username: 'fixture-admin', password } })
        const cookie = login.headers['set-cookie']?.[0]?.split(';')[0]
        assert.ok(cookie?.startsWith('admin_session='))
        assert.deepEqual((await call('/api/admin/me', 200, { cookie })).json, { id: fixture.adminId, username: 'fixture-admin' })
        const adminVideos = await call('/api/admin/videos', 200, { cookie })
        assert.equal(adminVideos.json.total, 1)
        assert.deepEqual(adminVideos.json.data.map(video => video.id), [fixture.videoId])
        assert.equal((await call('/api/admin/logout', 204, { method: 'POST', cookie })).text, '')
        assert.equal((await call('/api/videos?page=0', 400)).json.code, 'VALIDATION_ERROR')
        assert.equal((await call('/api/runtime-missing', 404)).json.code, 'NOT_FOUND')
        assert.equal(calls, 16)
        beforeStop = snapshot()
      } finally {
        const result = await command.stop()
        assert.equal(result.failure, undefined)
        assert.equal(command.running, false)
        assert.doesNotMatch(result.stdout + result.stderr, /INTERNAL_ERROR|EADDRINUSE|UnhandledPromiseRejection/)
      }
      // Forced process-tree cleanup is not a graceful shutdown hook; verify released OS resources explicitly.
      assert.equal(await availablePort(port), port)
      database.exec('BEGIN EXCLUSIVE')
      database.exec('ROLLBACK')
      assert.deepEqual(snapshot(), beforeStop)
      const reopened = context.open(databasePath)
      assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM video_views').get().count, 2)
      assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM video_likes').get().count, 1)
      assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
    })
  }
})
