import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'
import { multipart } from '../helpers/multipart.js'

// These signatures exercise upload validation, not playable production media.
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const visitor = '00000000-0000-4000-8000-000000000002'
const quiz = { question: 'Original question?', options: [
  { content: 'First', isCorrect: true }, { content: 'Second', isCorrect: false },
] }
const replacementQuiz = { question: 'Replacement question?', options: [
  { content: 'Last in meaning', isCorrect: false }, { content: 'Answer', isCorrect: true },
  { content: 'First in meaning', isCorrect: false },
] }
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('real administrator saves and deletes stay consistent with all public video consumers', { timeout: 30000 }, async t => {
  const { request, login, getDb, uploadDir } = await startAuthServer(t, { uploads: true })
  const { res, cookie } = await login()
  assert.equal(res.status, 200)
  assert.ok(cookie)
  const db = getDb()
  const addTag = db.prepare('INSERT INTO tags (name) VALUES (?)')
  const alpha = addTag.run('Alpha').lastInsertRowid
  const beta = addTag.run('Beta').lastInsertRowid
  const addCourse = db.prepare('INSERT INTO courses (name) VALUES (?)')
  const firstCourse = addCourse.run('First shared course').lastInsertRowid
  const secondCourse = addCourse.run('Second shared course').lastInsertRowid
  const courses = new Map([[firstCourse, []], [secondCourse, []]])
  const active = new Set()
  let target
  let control
  let commentId
  let retainedControl

  const admin = (path, method, body, options = {}) => request(path, { method, body, cookie, ...options })
  const patch = body => admin(`/api/admin/videos/${target.id}`, 'PATCH', body)
  const upload = async (kind, data = kind === 'video' ? mp4 : png) => {
    const { body, contentType } = multipart([
      { name: 'kind', data: kind }, { name: 'file', filename: 'sample.bin', data },
    ])
    const result = await admin('/api/admin/uploads', 'POST', body, { headers: { 'Content-Type': contentType } })
    assert.equal(result.status, 201, result.text)
    return result.json.path
  }
  const create = async (title, tagId) => {
    const result = await admin('/api/admin/videos', 'POST', {
      title, description: `${title} description`, videoPath: await upload('video'),
      thumbnailPath: await upload('thumbnail'), tagIds: [tagId], quiz,
    })
    assert.equal(result.status, 201, result.text)
    assert.equal(result.headers.location, `/api/admin/videos/${result.json.id}`)
    active.add(result.json.id)
    return result.json
  }
  const rows = () => Object.fromEntries(tables.map(table =>
    [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()]))
  const files = (directory = uploadDir) => readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
      assert.equal(entry.isSymbolicLink(), false)
      const path = join(directory, entry.name)
      return [entry.name, entry.isDirectory() ? files(path) : createHash('sha256').update(readFileSync(path)).digest('hex')]
    })
  async function get(path, visitorId = null) {
    const result = await request(path, { headers: visitorId === null ? {} : { 'X-Visitor-Id': visitorId } })
    assert.equal(result.status, 200, path)
    assert.equal(result.headers['set-cookie'], undefined)
    return result.json
  }
  async function publicState() {
    const before = rows()
    const result = { tags: await get('/api/tags'), courses: await get('/api/courses'), visitors: [] }
    for (const visitorId of [null, visitor]) {
      const list = await get('/api/videos', visitorId)
      assert.deepEqual(list.data.map(item => item.id), [...active].sort((a, b) => b - a))
      assert.equal(list.total, active.size)
      const filtered = []
      for (const tag of [alpha, beta]) {
        const page = await get(`/api/videos?tagId=${tag}`, visitorId)
        const expected = list.data.filter(item => item.tags.some(value => value.id === tag))
        assert.deepEqual(page.data, expected)
        assert.equal(page.total, expected.length)
        filtered.push(page)
      }
      const details = []
      for (const item of list.data) {
        assert.deepEqual(await get(`/api/videos/${item.id}`, visitorId), item)
        const edit = await request(`/api/admin/videos/${item.id}`, { cookie })
        assert.equal(edit.status, 200)
        const { tagIds, videoPath, thumbnailPath, quiz: storedQuiz, ...publicItem } = edit.json
        assert.deepEqual(item, { ...publicItem, likedByMe: visitorId !== null && item.likeCount > 0 })
        assert.deepEqual(item.tags.map(tag => tag.id).sort((a, b) => a - b), tagIds)
        assert.equal(item.videoUrl, `/uploads/${videoPath}`)
        assert.equal(item.thumbnailUrl, thumbnailPath === null ? '/images/default-thumbnail.svg' : `/uploads/${thumbnailPath}`)
        assert.equal(item.hasQuiz, storedQuiz !== null)
        const quizResult = await request(`/api/videos/${item.id}/quiz`)
        assert.equal(quizResult.status, storedQuiz === null ? 404 : 200)
        if (storedQuiz !== null) assert.deepEqual(quizResult.json, storedQuiz)
        const comments = await get(`/api/videos/${item.id}/comments`)
        assert.equal(comments.total, item.commentCount)
        assert.equal(comments.data.length, item.commentCount)
        assert.ok(comments.data.every(comment => Object.keys(comment).join(',') === 'id,videoId,nickname,content,createdAt'))
        details.push({ item, quiz: quizResult.json, comments })
      }
      const courseDetails = []
      for (const [id, ids] of courses) {
        const detail = await get(`/api/courses/${id}`, visitorId)
        assert.equal(detail.videoCount, ids.length)
        assert.deepEqual(detail.videos, ids.map((videoId, index) => ({
          ...list.data.find(item => item.id === videoId), sortOrder: index + 1,
        })))
        assert.equal(result.courses.data.find(course => course.id === id).videoCount, ids.length)
        courseDetails.push(detail)
      }
      result.visitors.push({ list, filtered, details, courses: courseDetails })
    }
    assert.deepEqual(rows(), before, 'public reads must not write to the database')
    assert.equal(db.isTransaction, false)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    if (retainedControl && active.has(control.id)) {
      assert.deepEqual(await get(`/api/videos/${control.id}`), retainedControl)
    }
    return result
  }

  await t.test('administrator creation publishes tags, URLs and quiz without exposing edit-only fields', async () => {
    control = await create('Control video', beta)
    target = await create('Target video', alpha)
    // Courses are fixtures; administrator course management belongs to another owner.
    const insert = db.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)')
    courses.set(firstCourse, [target.id, control.id])
    courses.set(secondCourse, [control.id, target.id])
    for (const [id, ids] of courses) ids.forEach((videoId, index) => insert.run(id, videoId, index + 1))
    await publicState()
    retainedControl = await get(`/api/videos/${control.id}`)
    for (const [suffix, method] of [['view', 'POST'], ['like', 'PUT']]) {
      const response = await request(`/api/videos/${target.id}/${suffix}`, { method, headers: { 'X-Visitor-Id': visitor } })
      assert.equal(response.status, 200)
    }
    const comment = await request(`/api/videos/${target.id}/comments`, {
      method: 'POST', body: { nickname: 'Learner', password: '1234', content: 'Retain on edit, cascade on deletion' },
    })
    assert.equal(comment.status, 201)
    commentId = comment.json.id
    const detail = await get(`/api/videos/${target.id}`, visitor)
    assert.deepEqual([detail.viewCount, detail.likeCount, detail.commentCount, detail.likedByMe], [1, 1, 1, true])
    await publicState()
  })

  await t.test('administrator edits replace public metadata and quiz while preserving learner reactions and course order', async () => {
    const nextVideo = await upload('video')
    const changed = await patch({ title: 'Updated title', description: 'Updated description',
      tagIds: [beta], videoPath: nextVideo, thumbnailPath: null, quiz: replacementQuiz })
    assert.equal(changed.status, 200, changed.text)
    assert.equal(changed.json.createdAt, target.createdAt)
    assert.equal(changed.json.title, 'Updated title')
    assert.deepEqual(changed.json.quiz.options.map(option => [option.content, option.sortOrder, option.isCorrect]),
      replacementQuiz.options.map((option, index) => [option.content, index + 1, option.isCorrect]))
    assert.equal(existsSync(join(uploadDir, target.videoPath)), false)
    assert.equal(existsSync(join(uploadDir, target.thumbnailPath)), false)
    target = changed.json
    await publicState()
    assert.equal((await patch({ quiz: null, tagIds: [] })).status, 200)
    await publicState()
    const noQuiz = await request(`/api/videos/${target.id}/quiz`)
    assert.deepEqual([noQuiz.status, noQuiz.json.code], [404, 'NOT_FOUND'])
    assert.equal((await patch({ quiz, tagIds: [alpha, beta] })).status, 200)
    await publicState()
    const detail = await get(`/api/videos/${target.id}`, visitor)
    assert.deepEqual([detail.viewCount, detail.likeCount, detail.commentCount, detail.likedByMe], [1, 1, 1, true])
  })

  await t.test('rejected and rolled-back administrator writes preserve public responses, relationships and files', async st => {
    const spareVideo = await upload('video')
    const newBody = { title: 'Must not publish', videoPath: spareVideo, tagIds: [beta], quiz }
    const baseline = { rows: rows(), files: files(), public: await publicState() }
    const unchanged = async () => {
      assert.deepEqual(rows(), baseline.rows)
      assert.deepEqual(files(), baseline.files)
      assert.deepEqual(await publicState(), baseline.public)
    }
    for (const [path, method, body] of [
      ['/api/admin/videos', 'POST', newBody],
      [`/api/admin/videos/${target.id}`, 'PATCH', { title: 'Unauthorized change' }],
      [`/api/admin/videos/${target.id}`, 'DELETE', undefined],
    ]) {
      const result = await request(path, { method, body })
      assert.equal(result.status, 401)
      await unchanged()
    }
    const forbidden = await admin(`/api/admin/videos/${target.id}`, 'PATCH', { quiz: null },
      { headers: { Origin: 'http://evil.example' } })
    assert.equal(forbidden.status, 403)
    await unchanged()
    const invalid = await patch({ title: 'Must roll back', tagIds: [999999], quiz: null })
    assert.equal(invalid.status, 400)
    assert.ok(invalid.json.fields.tagIds)
    await unchanged()

    const log = st.mock.method(console, 'error', () => {})
    // Faults happen after dependent writes, so this checks actual transaction rollback.
    const cases = [
      ['AFTER INSERT ON quiz_options', '/api/admin/videos', 'POST', newBody],
      ['AFTER UPDATE ON videos', `/api/admin/videos/${target.id}`, 'PATCH',
        { title: 'Must roll back', videoPath: spareVideo, tagIds: [beta], quiz: replacementQuiz }],
      ['AFTER DELETE ON videos', `/api/admin/videos/${target.id}`, 'DELETE', undefined],
    ]
    for (const [event, path, method, body] of cases) {
      db.exec(`CREATE TRIGGER integration_write_fault ${event} BEGIN SELECT RAISE(ABORT, 'test-only storage fault'); END`)
      try {
        const result = await admin(path, method, body)
        assert.deepEqual([result.status, result.json.code, result.json.fields], [500, 'INTERNAL_ERROR', {}])
        assert.deepEqual(Object.keys(result.json), ['code', 'message', 'fields'])
        assert.equal(result.text.includes('test-only storage fault'), false)
        assert.equal(result.text.includes(uploadDir), false)
      } finally {
        db.exec('DROP TRIGGER integration_write_fault')
      }
      await unchanged()
    }
    assert.deepEqual(log.mock.calls.filter(call => call.arguments[0] === 'INTERNAL_ERROR').map(call => call.arguments),
      [['INTERNAL_ERROR'], ['INTERNAL_ERROR'], ['INTERNAL_ERROR']])
  })

  await t.test('administrator deletion removes every public reference and compacts shared courses without deleting their owners', async () => {
    const quizId = (await get(`/api/videos/${target.id}/quiz`)).id
    const response = await admin(`/api/admin/videos/${target.id}`, 'DELETE')
    assert.deepEqual([response.status, response.text], [204, ''])
    active.delete(target.id)
    for (const id of courses.keys()) courses.set(id, [control.id])
    await publicState()
    for (const table of ['video_tags', 'course_videos', 'video_views', 'video_likes', 'comments', 'quizzes']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE video_id = ?`).get(target.id).total, 0)
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM quiz_options WHERE quiz_id = ?').get(quizId).total, 0)
    assert.equal(existsSync(join(uploadDir, target.videoPath)), false)
    for (const suffix of ['', '/comments', '/quiz']) {
      const missing = await request(`/api/videos/${target.id}${suffix}`)
      assert.deepEqual([missing.status, missing.json.code], [404, 'NOT_FOUND'])
    }
    const comment = await request(`/api/comments/${commentId}`, { method: 'DELETE', body: { password: '1234' } })
    assert.deepEqual([comment.status, comment.json.code], [404, 'NOT_FOUND'])
    for (const [suffix, method] of [['view', 'POST'], ['like', 'PUT'], ['like', 'DELETE']]) {
      const missing = await request(`/api/videos/${target.id}/${suffix}`, { method, headers: { 'X-Visitor-Id': visitor } })
      assert.deepEqual([missing.status, missing.json.code], [404, 'NOT_FOUND'])
    }
    assert.equal((await admin(`/api/admin/videos/${target.id}`, 'DELETE')).status, 404)
    assert.ok(existsSync(join(uploadDir, control.videoPath)))
    assert.ok(existsSync(join(uploadDir, control.thumbnailPath)))
    assert.equal((await admin(`/api/admin/videos/${control.id}`, 'DELETE')).status, 204)
    active.clear()
    for (const id of courses.keys()) courses.set(id, [])
    await publicState()
    assert.equal((await get('/api/tags')).data.length, 2)
    assert.equal((await get('/api/courses')).total, 2)
  })
})
