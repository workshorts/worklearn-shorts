import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { hashPassword } from '../../src/lib/password.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']
const visitor = '00000000-0000-4000-8000-000000000002'
const password = 'public-secret-123'
const marker = 'public-contract-native-only'
const videoKeys = ['id', 'title', 'description', 'tags', 'videoUrl', 'thumbnailUrl', 'viewCount', 'likeCount',
  'likedByMe', 'commentCount', 'hasQuiz', 'createdAt', 'updatedAt']
const courseKeys = ['id', 'name', 'description', 'videoCount', 'createdAt', 'updatedAt']
const commentKeys = ['id', 'videoId', 'nickname', 'content', 'createdAt']
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function keys(value, expected) { assert.deepEqual(Object.keys(value).sort(), [...expected].sort()) }
function positive(value) { assert.ok(Number.isSafeInteger(value) && value > 0) }
function tag(value) { keys(value, ['id', 'name']); positive(value.id); assert.equal(typeof value.name, 'string') }
function video(value, inCourse = false) {
  keys(value, inCourse ? [...videoKeys, 'sortOrder'] : videoKeys)
  positive(value.id)
  for (const field of ['title', 'description']) assert.equal(typeof value[field], 'string')
  assert.match(value.videoUrl, /^\/uploads\/videos\//)
  assert.equal(typeof value.thumbnailUrl, 'string')
  assert.ok(Array.isArray(value.tags))
  value.tags.forEach(tag)
  for (const field of ['viewCount', 'likeCount', 'commentCount']) assert.ok(Number.isSafeInteger(value[field]) && value[field] >= 0)
  for (const field of ['likedByMe', 'hasQuiz']) assert.equal(typeof value[field], 'boolean')
  for (const field of ['createdAt', 'updatedAt']) assert.match(value[field], iso)
  if (inCourse) positive(value.sortOrder)
}
function course(value, detail = false) {
  keys(value, detail ? [...courseKeys, 'videos'] : courseKeys)
  positive(value.id)
  for (const field of ['name', 'description']) assert.equal(typeof value[field], 'string')
  assert.ok(Number.isSafeInteger(value.videoCount) && value.videoCount >= 0)
  for (const field of ['createdAt', 'updatedAt']) assert.match(value[field], iso)
  if (detail) { assert.equal(value.videoCount, value.videos.length); value.videos.forEach(item => video(item, true)) }
}
function comment(value) {
  keys(value, commentKeys)
  positive(value.id); positive(value.videoId)
  assert.equal(typeof value.nickname, 'string'); assert.equal(typeof value.content, 'string')
  assert.match(value.createdAt, iso)
}
function page(value, item) {
  keys(value, ['data', 'page', 'limit', 'total'])
  assert.ok(Array.isArray(value.data)); positive(value.page); positive(value.limit)
  assert.ok(Number.isSafeInteger(value.total) && value.total >= 0)
  value.data.forEach(entry => item(entry))
}

test('all twelve public APIs share safe response, error, empty-value and recovery contracts', { timeout: 30000 }, async t => {
  const settings = { COMMENT_CREATE_MAX: '3', COMMENT_CREATE_WINDOW_SECONDS: '600',
    COMMENT_DELETE_MAX: '3', COMMENT_DELETE_WINDOW_SECONDS: '600' }
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]))
  Object.assign(process.env, settings)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const db = getDb()
  const fixture = insertMinimalFixture(db)
  const mediaPath = 'videos/10000000-0000-4000-8000-000000000001.mp4'
  db.prepare('UPDATE videos SET video_path = ? WHERE id = ?').run(mediaPath, fixture.videoId)
  const storedHash = hashPassword(password)
  db.prepare('UPDATE comments SET password_hash = ? WHERE id = ?').run(storedHash, fixture.commentId)
  const emptyVideo = db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)').run('Empty control', mediaPath).lastInsertRowid
  const emptyCourse = db.prepare('INSERT INTO courses (name) VALUES (?)').run('Empty course').lastInsertRowid
  const unusedTag = db.prepare('INSERT INTO tags (name) VALUES (?)').run('Unused tag').lastInsertRowid
  const secrets = new Set([password, storedHash, marker])
  let createdComment
  const payload = { nickname: 'Public author', password, content: 'Public comment' }
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  function response(response, status) {
    assert.equal(response.status, status)
    if (status !== 204) assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.equal(response.headers['x-private-contract'], undefined)
    if (status !== 429) assert.equal(response.headers['retry-after'], undefined)
    for (const value of [response.text, JSON.stringify(response.headers)]) {
      for (const secret of secrets) assert.equal(value.includes(secret), false, 'Private data reached a public response')
      assert.doesNotMatch(value, /scrypt\$/)
    }
    assert.equal(db.isOpen, true)
    assert.equal(db.isTransaction, false)
  }
  function error(result, status, code, fields = []) {
    response(result, status)
    keys(result.json, ['code', 'message', 'fields'])
    assert.equal(result.json.code, code)
    assert.equal(typeof result.json.message, 'string')
    keys(result.json.fields, fields)
  }
  const videoPath = `/api/videos/${fixture.videoId}`
  const routes = [
    { name: 'tags', method: 'GET', path: '/api/tags', status: 200,
      check: value => { keys(value, ['data']); value.data.forEach(tag) } },
    { name: 'videos', method: 'GET', path: '/api/videos', status: 200, check: value => page(value, video) },
    { name: 'video', method: 'GET', path: videoPath, status: 200, check: video },
    { name: 'courses', method: 'GET', path: '/api/courses', status: 200, check: value => page(value, course) },
    { name: 'course', method: 'GET', path: `/api/courses/${fixture.courseId}`, status: 200, check: value => course(value, true) },
    { name: 'view', method: 'POST', path: `${videoPath}/view`, status: 200,
      check: value => { keys(value, ['videoId', 'viewCount', 'counted']); assert.deepEqual(value, { videoId: fixture.videoId, viewCount: 2, counted: true }) } },
    { name: 'like', method: 'PUT', path: `${videoPath}/like`, status: 200,
      check: value => { keys(value, ['videoId', 'likeCount', 'likedByMe']); assert.deepEqual(value, { videoId: fixture.videoId, likeCount: 2, likedByMe: true }) } },
    { name: 'unlike', method: 'DELETE', path: `${videoPath}/like`, status: 200,
      check: value => { keys(value, ['videoId', 'likeCount', 'likedByMe']); assert.deepEqual(value, { videoId: fixture.videoId, likeCount: 1, likedByMe: false }) } },
    { name: 'comments', method: 'GET', path: `${videoPath}/comments`, status: 200, check: value => page(value, comment) },
    { name: 'create-comment', method: 'POST', path: `${videoPath}/comments`, body: payload, status: 201,
      check: value => { comment(value); assert.equal(value.videoId, fixture.videoId); assert.equal(value.content, payload.content); createdComment = value.id } },
    { name: 'delete-comment', method: 'DELETE', path: `/api/comments/${fixture.commentId}`, body: { password }, status: 204 },
    { name: 'quiz', method: 'GET', path: `${videoPath}/quiz`, status: 200, check: value => {
      keys(value, ['id', 'videoId', 'question', 'options']); positive(value.id); assert.equal(value.videoId, fixture.videoId)
      assert.equal(typeof value.question, 'string'); assert.ok(Array.isArray(value.options))
      value.options.forEach(option => {
        keys(option, ['id', 'content', 'sortOrder', 'isCorrect']); positive(option.id); positive(option.sortOrder)
        assert.equal(typeof option.content, 'string'); assert.equal(typeof option.isCorrect, 'boolean')
      })
    } },
  ]
  const send = route => request(route.path, { method: route.method, body: route.body,
    headers: { 'X-Visitor-Id': visitor, Origin: 'https://other.example.test' }, cookie: 'admin_session=invalid-unused-session' })

  await t.test('every route hides untrusted native error details and recovers to its exact success shape', async subtest => {
    assert.equal(routes.length, 12)
    const log = subtest.mock.method(console, 'error', () => {})
    for (const route of routes) {
      const before = snapshot()
      const failure = Object.assign(new Error(`${marker}: ${password}: ${storedHash}`, { cause: new Error(marker) }),
        { status: 404, code: 'NOT_FOUND', fields: { internal: marker }, headers: { 'X-Private-Contract': marker } })
      const fault = subtest.mock.method(db, 'prepare', () => { throw failure })
      try {
        const result = await send(route)
        error(result, 500, 'INTERNAL_ERROR')
        assert.deepEqual(result.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
        assert.equal(fault.mock.callCount(), 1, route.name)
      } finally { fault.mock.restore() }
      assert.deepEqual(snapshot(), before)
      const recovered = await send(route)
      if (route.name === 'create-comment') {
        secrets.add(db.prepare('SELECT password_hash FROM comments WHERE id = ?').get(recovered.json.id).password_hash)
      }
      response(recovered, route.status)
      if (route.status === 204) {
        assert.equal(recovered.text, ''); assert.equal(recovered.json, null)
        assert.equal(recovered.headers['content-type'], undefined)
        assert.equal(db.prepare('SELECT id FROM comments WHERE id = ?').get(fixture.commentId), undefined)
      } else route.check(recovered.json)
      if (route.method === 'GET') assert.deepEqual(snapshot(), before)
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), Array.from({ length: 12 }, () => ['INTERNAL_ERROR']))
  })

  await t.test('empty values and expected 400, 403, 404, 415 and 429 errors keep their public shapes without writes', async subtest => {
    const before = snapshot()
    const log = subtest.mock.method(console, 'error', () => {})
    for (const path of [`/api/videos?tagId=${unusedTag}`, `/api/videos/${emptyVideo}/comments`]) {
      const result = await request(path)
      response(result, 200)
      assert.deepEqual(result.json, { data: [], page: 1, limit: 20, total: 0 })
    }
    const empty = await request(`/api/courses/${emptyCourse}`)
    response(empty, 200); course(empty.json, true)
    assert.deepEqual(empty.json.videos, []); assert.equal(empty.json.videoCount, 0)
    const end = await request('/api/courses?page=99')
    response(end, 200); assert.deepEqual(end.json, { data: [], page: 99, limit: 20, total: 2 })
    for (const [path, options, fields] of [
      ['/api/videos?page=0', {}, ['page']], ['/api/courses?limit=0', {}, ['limit']],
      ['/api/courses/0', {}, ['id']], [`${videoPath}/comments?page=0`, {}, ['page']],
      [`${videoPath}/comments`, { method: 'POST', body: {} }, ['nickname', 'password', 'content']],
      ['/api/videos/0/quiz', {}, ['id']],
      ...['POST', 'PUT', 'DELETE'].map((method, index) => [`${videoPath}/${index === 0 ? 'view' : 'like'}`, { method }, ['visitorId']]),
    ]) error(await request(path, options), 400, 'VALIDATION_ERROR', fields)
    for (const path of ['/api/videos/999999', '/api/courses/999999', '/api/videos/999999/comments',
      '/api/videos/999999/quiz', `/api/videos/${emptyVideo}/quiz`]) error(await request(path), 404, 'NOT_FOUND')
    for (const [method, suffix] of [['POST', 'view'], ['PUT', 'like'], ['DELETE', 'like']]) {
      error(await request(`/api/videos/999999/${suffix}`, { method, headers: { 'X-Visitor-Id': visitor } }), 404, 'NOT_FOUND')
    }
    for (const [path, method, body] of [
      [`${videoPath}/comments`, 'POST', payload], [`/api/comments/${createdComment}`, 'DELETE', { password }],
    ]) error(await request(path, { method, body, headers: { 'Content-Type': 'text/plain' } }), 415, 'UNSUPPORTED_MEDIA_TYPE')
    error(await request(`${videoPath}/comments`, { method: 'POST', body: '{bad' }), 400, 'INVALID_JSON')
    error(await request(`/api/comments/${createdComment}`, { method: 'DELETE', body: { password: 'wrong-password' } }),
      403, 'COMMENT_PASSWORD_MISMATCH')
    error(await request('/api/videos/999999/comments', { method: 'POST', body: payload }), 404, 'NOT_FOUND')
    for (const [path, method, body] of [
      [`${videoPath}/comments`, 'POST', payload], [`/api/comments/${createdComment}`, 'DELETE', { password }],
    ]) {
      const limited = await request(path, { method, body })
      error(limited, 429, 'RATE_LIMITED')
      assert.match(limited.headers['retry-after'], /^[1-9]\d*$/)
      assert.ok(Number(limited.headers['retry-after']) <= 600)
    }
    assert.equal(log.mock.callCount(), 0)
    assert.deepEqual(snapshot(), before)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  })
})
