import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { withTransaction } from '../../src/db/transaction.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('Video.hasQuiz and public quiz responses agree after committed and rolled-back quiz changes', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const db = getDb()
  const fixture = insertMinimalFixture(db)
  const mediaPath = 'videos/10000000-0000-4000-8000-000000000001.mp4'
  db.prepare('UPDATE videos SET video_path = ? WHERE id = ?').run(mediaPath, fixture.videoId)
  const video = db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
  const control = video.run('Unchanged quiz control', mediaPath).lastInsertRowid
  const empty = video.run('Initially no quiz', mediaPath).lastInsertRowid
  db.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(control, fixture.tagId)
  const extraTag = db.prepare('INSERT INTO tags (name) VALUES (?)').run('Extra quiz tag').lastInsertRowid
  db.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(fixture.videoId, extraTag)
  function addOptions(connection, quizId, firstCorrect = true) {
    const options = [
      { content: 'First choice', sortOrder: 1, isCorrect: firstCorrect },
      { content: 'Second choice', sortOrder: 2, isCorrect: !firstCorrect },
    ]
    const insert = connection.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
    for (const option of [...options].reverse()) {
      option.id = insert.run(quizId, option.content, option.sortOrder, option.isCorrect ? 1 : 0).lastInsertRowid
    }
    return options.map(({ id, content, sortOrder, isCorrect }) => ({ id, content, sortOrder, isCorrect }))
  }
  function addQuiz(connection, videoId, question) {
    const id = connection.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)').run(videoId, question).lastInsertRowid
    return { id, videoId, question, options: addOptions(connection, id) }
  }
  const controlQuiz = withTransaction(db, connection => addQuiz(connection, control, 'Control question?'))
  const model = new Map([
    [fixture.videoId, { id: fixture.quizId, videoId: fixture.videoId, question: 'Fixture question?', options: [
      { id: fixture.correctOptionId, content: 'Correct option', sortOrder: 1, isCorrect: true },
      { id: fixture.incorrectOptionId, content: 'Incorrect option', sortOrder: 2, isCorrect: false },
    ] }],
    [control, controlQuiz], [empty, null],
  ])
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  const initial = snapshot()
  const stableVideos = new Map()
  let checkpoints = 0
  async function state() {
    const before = snapshot()
    for (const table of tables.filter(table => !['quizzes', 'quiz_options', 'sqlite_sequence'].includes(table))) {
      assert.deepEqual(before.rows[table], initial.rows[table])
    }
    assert.deepEqual(before.rows.quizzes.filter(row => row.video_id === control), initial.rows.quizzes.filter(row => row.video_id === control))
    assert.deepEqual(before.rows.quiz_options.filter(row => row.quiz_id === controlQuiz.id),
      initial.rows.quiz_options.filter(row => row.quiz_id === controlQuiz.id))
    assert.deepEqual(before.schema, initial.schema)
    for (const [id, expected] of model) {
      const stored = db.prepare('SELECT id, question FROM quizzes WHERE video_id = ?').get(id)
      if (expected === null) assert.equal(stored, undefined)
      else assert.deepEqual({ id: stored.id, question: stored.question }, { id: expected.id, question: expected.question })
      const response = await request(`/api/videos/${id}/quiz`)
      assert.equal(response.status, expected === null ? 404 : 200)
      assert.deepEqual(response.json, expected ?? { code: 'NOT_FOUND', message: '퀴즈를 찾을 수 없습니다.', fields: {} })
      assert.equal(response.headers['set-cookie'], undefined)
      assert.equal(db.isTransaction, false)
    }
    for (const visitor of [null, fixture.visitorId]) {
      const headers = visitor === null ? {} : { 'X-Visitor-Id': visitor }
      async function get(path) {
        const response = await request(path, { headers })
        assert.equal(response.status, 200, path)
        assert.equal(response.headers['set-cookie'], undefined)
        assert.equal(db.isTransaction, false)
        return response.json
      }
      function check(item) {
        assert.equal(typeof item.hasQuiz, 'boolean')
        assert.equal(item.hasQuiz, model.get(item.id) !== null)
        const { hasQuiz, ...unchanged } = item
        const key = `${visitor}:${item.id}`
        if (!stableVideos.has(key)) stableVideos.set(key, unchanged)
        else assert.deepEqual(unchanged, stableVideos.get(key))
      }
      for (const [suffix, ids, limit] of [
        ['', [empty, control, fixture.videoId], 2], [`&tagId=${fixture.tagId}`, [control, fixture.videoId], 1],
      ]) {
        const collected = []
        for (let page = 1; page <= Math.ceil(ids.length / limit) + 1; page++) {
          const result = await get(`/api/videos?page=${page}&limit=${limit}${suffix}`)
          assert.equal(result.total, ids.length)
          assert.deepEqual(result.data.map(item => item.id), ids.slice((page - 1) * limit, page * limit))
          result.data.forEach(check)
          collected.push(...result.data.map(item => item.id))
        }
        assert.deepEqual(collected, ids)
      }
      for (const id of model.keys()) check(await get(`/api/videos/${id}`))
    }
    assert.deepEqual(snapshot(), before)
    checkpoints += 1
  }

  await t.test('initial presence and adding a quiz to an inactive video agree in every public read', async () => {
    await state()
    model.set(empty, withTransaction(db, connection => addQuiz(connection, empty, 'New question?')))
    await state()
  })

  await t.test('deletion, recreation with new IDs and option replacement refresh presence without altering controls', async () => {
    withTransaction(db, connection => connection.prepare('DELETE FROM quizzes WHERE id = ?').run(fixture.quizId))
    model.set(fixture.videoId, null)
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM quiz_options WHERE quiz_id = ?').get(fixture.quizId).total, 0)
    await state()
    const replacement = withTransaction(db, connection => addQuiz(connection, fixture.videoId, 'Replacement question?'))
    assert.notEqual(replacement.id, fixture.quizId)
    model.set(fixture.videoId, replacement)
    await state()
    const edited = withTransaction(db, connection => {
      connection.prepare('UPDATE quizzes SET question = ? WHERE id = ?').run('Edited question?', replacement.id)
      connection.prepare('DELETE FROM quiz_options WHERE quiz_id = ?').run(replacement.id)
      return { ...replacement, question: 'Edited question?', options: addOptions(connection, replacement.id, false) }
    })
    model.set(fixture.videoId, edited)
    await state()
    db.prepare('DELETE FROM quizzes WHERE id = ?').run(model.get(empty).id)
    model.set(empty, null)
    await state()
  })

  await t.test('rolled-back quiz deletion and creation cannot change hasQuiz or subsequent quiz responses', async () => {
    for (const operation of [
      connection => connection.prepare('DELETE FROM quizzes WHERE id = ?').run(model.get(fixture.videoId).id),
      connection => addQuiz(connection, empty, 'Discarded question?'),
    ]) {
      const before = snapshot()
      const failure = new Error('Rollback-only quiz fixture mutation')
      assert.throws(() => withTransaction(db, connection => { operation(connection); throw failure }), error => error === failure)
      assert.equal(db.isTransaction, false)
      assert.deepEqual(snapshot(), before)
      await state()
    }
    assert.equal(checkpoints, 8)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  })
})
