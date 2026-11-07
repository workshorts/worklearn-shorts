import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { withTransaction } from '../../src/db/transaction.js'
import { hashPassword } from '../../src/lib/password.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']
const otherVisitor = '00000000-0000-4000-8000-000000000002'
const payload = { nickname: 'Learner', password: '1234', content: 'Shared-course comment' }

test('course details and video APIs stay consistent across comment, quiz and course membership changes', { timeout: 30000 }, async t => {
  const settings = { COMMENT_CREATE_MAX: '100', COMMENT_CREATE_WINDOW_SECONDS: '600',
    COMMENT_DELETE_MAX: '100', COMMENT_DELETE_WINDOW_SECONDS: '600' }
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
  const path = 'videos/10000000-0000-4000-8000-000000000001.mp4'
  const passwordHash = hashPassword(payload.password)
  db.prepare('UPDATE videos SET video_path = ? WHERE id = ?').run(path, fixture.videoId)
  db.prepare('UPDATE comments SET password_hash = ? WHERE id = ?').run(passwordHash, fixture.commentId)
  const addVideo = db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
  const control = addVideo.run('Shared control', path).lastInsertRowid
  const empty = addVideo.run('Initially empty', path).lastInsertRowid
  db.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)')
    .run(control, 'Control author', passwordHash, 'Retained control comment')
  db.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(control, fixture.tagId)
  const addCourse = db.prepare('INSERT INTO courses (name) VALUES (?)')
  const secondCourse = addCourse.run('Second shared course').lastInsertRowid
  const emptyCourse = addCourse.run('Initially empty course').lastInsertRowid
  function replaceMembership(connection, courseId, ids) {
    connection.prepare('DELETE FROM course_videos WHERE course_id = ?').run(courseId)
    const insert = connection.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)')
    ids.forEach((id, index) => insert.run(courseId, id, index + 1))
  }
  function addOptions(connection, quizId, firstCorrect = true) {
    const result = [
      { content: 'First choice', sortOrder: 1, isCorrect: firstCorrect },
      { content: 'Second choice', sortOrder: 2, isCorrect: !firstCorrect },
    ]
    const insert = connection.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
    for (const option of [...result].reverse()) {
      option.id = insert.run(quizId, option.content, option.sortOrder, option.isCorrect ? 1 : 0).lastInsertRowid
    }
    return result.map(({ id, content, sortOrder, isCorrect }) => ({ id, content, sortOrder, isCorrect }))
  }
  function addQuiz(connection, videoId, question) {
    const id = connection.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)').run(videoId, question).lastInsertRowid
    return { id, videoId, question, options: addOptions(connection, id) }
  }
  const memberships = new Map([[fixture.courseId, [control, fixture.videoId, empty]],
    [secondCourse, [fixture.videoId, control]], [emptyCourse, []]])
  withTransaction(db, connection => {
    for (const [id, videos] of memberships) replaceMembership(connection, id, videos)
  })
  const controlQuiz = withTransaction(db, connection => addQuiz(connection, control, 'Control question?'))
  const quizzes = new Map([
    [fixture.videoId, { id: fixture.quizId, videoId: fixture.videoId, question: 'Fixture question?', options: [
      { id: fixture.correctOptionId, content: 'Correct option', sortOrder: 1, isCorrect: true },
      { id: fixture.incorrectOptionId, content: 'Incorrect option', sortOrder: 2, isCorrect: false },
    ] }], [control, controlQuiz], [empty, null],
  ])
  const counts = new Map([[fixture.videoId, 1], [control, 1], [empty, 0]])
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  const initial = snapshot()
  const stableVideos = new Map()
  let targetComment
  let emptyComment
  let checkpoints = 0
  async function get(path, visitor = null) {
    const response = await request(path, { headers: visitor === null ? {} : { 'X-Visitor-Id': visitor } })
    assert.equal(response.status, 200, path)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.equal(db.isTransaction, false)
    return response.json
  }
  async function state() {
    const before = snapshot()
    for (const table of tables.filter(table => !['comments', 'quizzes', 'quiz_options', 'course_videos', 'sqlite_sequence'].includes(table))) {
      assert.deepEqual(before.rows[table], initial.rows[table])
    }
    assert.deepEqual(before.rows.comments.filter(row => row.video_id === control), initial.rows.comments.filter(row => row.video_id === control))
    assert.deepEqual(before.rows.quizzes.filter(row => row.video_id === control), initial.rows.quizzes.filter(row => row.video_id === control))
    assert.deepEqual(before.rows.quiz_options.filter(row => row.quiz_id === controlQuiz.id), initial.rows.quiz_options.filter(row => row.quiz_id === controlQuiz.id))
    assert.deepEqual(before.schema, initial.schema)
    for (const [id, count] of counts) {
      assert.equal(db.prepare('SELECT COUNT(*) AS total FROM comments WHERE video_id = ?').get(id).total, count)
      const comments = await get(`/api/videos/${id}/comments?limit=50`)
      assert.equal(comments.total, count); assert.equal(comments.data.length, count)
      assert.ok(comments.data.every(comment => comment.videoId === id))
      const stored = db.prepare('SELECT id FROM quizzes WHERE video_id = ?').get(id)
      const expected = quizzes.get(id)
      assert.equal(stored?.id, expected?.id)
      const quiz = await request(`/api/videos/${id}/quiz`)
      assert.equal(quiz.status, expected === null ? 404 : 200)
      assert.deepEqual(quiz.json, expected ?? { code: 'NOT_FOUND', message: '퀴즈를 찾을 수 없습니다.', fields: {} })
    }
    const courseRows = new Map()
    for (const visitor of [null, fixture.visitorId, otherVisitor]) {
      const canonical = new Map()
      for (const id of counts.keys()) {
        const item = await get(`/api/videos/${id}`, visitor)
        assert.equal(item.commentCount, counts.get(id))
        assert.equal(item.hasQuiz, quizzes.get(id) !== null)
        assert.equal(item.likedByMe, id === fixture.videoId && visitor === fixture.visitorId)
        const { commentCount, hasQuiz, ...unchanged } = item
        const key = `${visitor}:${id}`
        if (!stableVideos.has(key)) stableVideos.set(key, unchanged)
        else assert.deepEqual(unchanged, stableVideos.get(key))
        canonical.set(id, item)
      }
      const ids = [...counts.keys()].sort((a, b) => b - a)
      const collected = []
      for (let page = 1; page <= 3; page++) {
        const list = await get(`/api/videos?page=${page}&limit=2`, visitor)
        assert.equal(list.total, ids.length)
        assert.deepEqual(list.data, ids.slice((page - 1) * 2, page * 2).map(id => canonical.get(id)))
        collected.push(...list.data.map(item => item.id))
      }
      assert.deepEqual(collected, ids)
      for (const [id, expectedIds] of memberships) {
        const detail = await get(`/api/courses/${id}`, visitor)
        assert.equal(detail.videoCount, expectedIds.length)
        assert.deepEqual(detail.videos.map(item => item.id), expectedIds)
        detail.videos.forEach((item, index) => {
          const { sortOrder, ...fromCourse } = item
          assert.equal(sortOrder, index + 1)
          assert.deepEqual(fromCourse, canonical.get(expectedIds[index]))
        })
        const { videos, ...summary } = detail
        if (!courseRows.has(id)) courseRows.set(id, summary)
        else assert.deepEqual(summary, courseRows.get(id))
      }
    }
    const courseIds = [...memberships.keys()].sort((a, b) => b - a)
    for (let page = 1; page <= 3; page++) {
      const list = await get(`/api/courses?page=${page}&limit=2`)
      assert.equal(list.total, courseIds.length)
      assert.deepEqual(list.data, courseIds.slice((page - 1) * 2, page * 2).map(id => courseRows.get(id)))
    }
    assert.deepEqual(snapshot(), before)
    checkpoints += 1
  }
  const post = id => request(`/api/videos/${id}/comments`, { method: 'POST', body: payload })
  const remove = (id, password = payload.password) => request(`/api/comments/${id}`, { method: 'DELETE', body: { password } })

  await t.test('public comment creation and deletion update every shared course while rejecting wrong passwords without changes', async () => {
    await state()
    const created = await post(fixture.videoId)
    assert.equal(created.status, 201); targetComment = created.json.id
    counts.set(fixture.videoId, 2); await state()
    const added = await post(empty)
    assert.equal(added.status, 201); emptyComment = added.json.id
    counts.set(empty, 1); await state()
    const before = snapshot()
    assert.equal((await remove(targetComment, 'wrong-password')).status, 403)
    assert.deepEqual(snapshot(), before); await state()
    assert.equal((await remove(fixture.commentId)).status, 204)
    counts.set(fixture.videoId, 1); await state()
    assert.equal((await remove(emptyComment)).status, 204)
    counts.set(empty, 0); await state()
  })

  await t.test('quiz replacement and committed course reordering refresh both course details without duplicating or losing videos', async () => {
    db.prepare('DELETE FROM quizzes WHERE id = ?').run(fixture.quizId)
    quizzes.set(fixture.videoId, null); await state()
    const replacement = withTransaction(db, connection => addQuiz(connection, fixture.videoId, 'Replacement shared question?'))
    assert.notEqual(replacement.id, fixture.quizId)
    quizzes.set(fixture.videoId, replacement); await state()
    quizzes.set(empty, withTransaction(db, connection => addQuiz(connection, empty, 'New independent question?')))
    await state()
    const next = new Map([[fixture.courseId, [fixture.videoId, control]],
      [secondCourse, [control, fixture.videoId]], [emptyCourse, [empty]]])
    const edited = withTransaction(db, connection => {
      for (const [id, videos] of next) replaceMembership(connection, id, videos)
      connection.prepare('UPDATE quizzes SET question = ? WHERE id = ?').run('Edited shared question?', replacement.id)
      connection.prepare('DELETE FROM quiz_options WHERE quiz_id = ?').run(replacement.id)
      return { ...replacement, question: 'Edited shared question?', options: addOptions(connection, replacement.id, false) }
    })
    for (const [id, videos] of next) memberships.set(id, videos)
    quizzes.set(fixture.videoId, edited); await state()
  })

  await t.test('a rolled-back mixed course, comment and quiz update leaves all public responses and persistent rows unchanged', async () => {
    const before = snapshot()
    const failure = new Error('Rollback-only mixed public fixture change')
    assert.throws(() => withTransaction(db, connection => {
      connection.prepare('DELETE FROM comments WHERE id = ?').run(targetComment)
      connection.prepare('DELETE FROM quizzes WHERE video_id = ?').run(fixture.videoId)
      replaceMembership(connection, fixture.courseId, [])
      connection.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)')
        .run(empty, 'Discarded author', passwordHash, 'Discarded comment')
      throw failure
    }), error => error === failure)
    assert.equal(db.isTransaction, false)
    assert.deepEqual(snapshot(), before)
    await state()
    assert.equal(checkpoints, 11)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  })
})
