import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('public quiz HTTP contracts cover every supported option count and correct-answer position', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const db = getDb()
  insertMinimalFixture(db)
  const insertVideo = db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
  const insertQuiz = db.prepare('INSERT INTO quizzes (id, video_id, question) VALUES (?, ?, ?)')
  const insertOption = db.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
  const models = []
  for (let count = 2; count <= 5; count++) {
    for (let correct = 0; correct < count; correct++) {
      const videoId = insertVideo.run('Contract target', 'unused-path').lastInsertRowid
      // Keep quiz and video IDs different so using the wrong resource ID cannot pass.
      const id = 1000 + models.length
      const question = count === 2 ? '?' : count === 5 ? '😀'.repeat(200) : ` Question ${count}\n e\u0301 `
      insertQuiz.run(id, videoId, question)
      const options = Array.from({ length: count }, (_, index) => ({
        content: index === 0 || index === 2 ? '😀'.repeat(100) : index === 1 ? '?' : ` Choice ${index + 1}\n e\u0301 `,
        sortOrder: index + 1, isCorrect: index === correct,
      }))
      // Reverse insertion order while the expected array follows the declared option order.
      for (const option of [...options].reverse()) {
        option.id = insertOption.run(id, option.content, option.sortOrder, option.isCorrect ? 1 : 0).lastInsertRowid
      }
      models.push({ id, videoId, question, options: options.map(({ id, content, sortOrder, isCorrect }) =>
        ({ id, content, sortOrder, isCorrect })) })
    }
  }
  const noQuizVideo = insertVideo.run('Existing parent without a quiz', 'unused-path').lastInsertRowid
  db.exec('PRAGMA query_only = ON')
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  const initial = snapshot()
  const get = id => request(`/api/videos/${id}/quiz`)
  function jsonResponse(response, status) {
    assert.equal(response.status, status)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.equal(response.headers['retry-after'], undefined)
    assert.equal(db.isTransaction, false)
  }

  await t.test('anonymous clients receive every ordered option with exact types and the public correct answer in all fourteen scenarios', async () => {
    assert.equal(models.length, 14)
    for (const expected of models) {
      const response = await get(expected.videoId)
      jsonResponse(response, 200)
      assert.deepEqual(Object.keys(response.json), ['id', 'videoId', 'question', 'options'])
      for (const id of [response.json.id, response.json.videoId]) assert.ok(Number.isSafeInteger(id) && id > 0)
      assert.equal(typeof response.json.question, 'string')
      assert.ok(Array.isArray(response.json.options))
      assert.equal(response.json.options.length, expected.options.length)
      assert.equal(new Set(response.json.options.map(option => option.id)).size, expected.options.length)
      response.json.options.forEach((option, index) => {
        assert.deepEqual(Object.keys(option), ['id', 'content', 'sortOrder', 'isCorrect'])
        assert.ok(Number.isSafeInteger(option.id) && option.id > 0)
        assert.equal(typeof option.content, 'string')
        assert.ok(Number.isInteger(option.sortOrder))
        assert.equal(option.sortOrder, index + 1)
        assert.equal(typeof option.isCorrect, 'boolean')
      })
      assert.equal(response.json.options.filter(option => option.isCorrect === true).length, 1)
      assert.deepEqual(response.json, expected)
    }
    assert.deepEqual(snapshot(), initial)
  })

  await t.test('malformed video IDs remain 400 and missing video and quiz resources have distinct 404s without an empty success', async () => {
    for (const id of ['0', '-1', '1.5', 'abc', '9007199254740992']) {
      const response = await get(id)
      jsonResponse(response, 400)
      assert.deepEqual(response.json, { code: 'VALIDATION_ERROR', message: '입력값을 확인하세요.',
        fields: { id: 'ID는 1 이상 9007199254740991 이하의 정수로 입력하세요.' } })
    }
    for (const [id, message] of [
      [noQuizVideo, '퀴즈를 찾을 수 없습니다.'], ['000' + noQuizVideo, '퀴즈를 찾을 수 없습니다.'],
      [Number.MAX_SAFE_INTEGER, '영상을 찾을 수 없습니다.'], [models[0].id, '영상을 찾을 수 없습니다.'],
    ]) {
      const response = await get(id)
      jsonResponse(response, 404)
      assert.deepEqual(response.json, { code: 'NOT_FOUND', message, fields: {} })
    }
    assert.deepEqual(snapshot(), initial)
  })
})
