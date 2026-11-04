import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { openExistingDatabase } from '../../src/db/connection.js'
import { verifyPassword } from '../../src/lib/password.js'
import { startAuthServer } from '../helpers/auth-server.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']
const payload = { nickname: ' 작성자 ', password: ' 12 ', content: ' 첫 줄\n다음 줄 😀 ' }
const internal = { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} }

test('public comment creation returns committed 201 DTOs and rolls back failures safely', { timeout: 30000 }, async t => {
  const previous = process.env.COMMENT_CREATE_MAX
  process.env.COMMENT_CREATE_MAX = '100'
  t.after(() => {
    if (previous === undefined) delete process.env.COMMENT_CREATE_MAX
    else process.env.COMMENT_CREATE_MAX = previous
  })
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const db = getDb()
  for (const id of [1, 2, 3, Number.MAX_SAFE_INTEGER]) {
    db.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(id, 'Comment target', 'unused-path')
  }
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  const post = (id = 1, body = payload, headers) => request(`/api/videos/${id}/comments`, { method: 'POST', body, headers })
  function publicComment(response, videoId, body = payload) {
    assert.equal(response.status, 201)
    assert.deepEqual(Object.keys(response.json), ['id', 'videoId', 'nickname', 'content', 'createdAt'])
    assert.ok(Number.isSafeInteger(response.json.id) && response.json.id > 0)
    assert.equal(response.json.videoId, videoId)
    assert.equal(response.json.nickname, body.nickname)
    assert.equal(response.json.content, body.content)
    assert.match(response.json.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.doesNotMatch(response.text, /scrypt\$|passwordHash|password_hash|"password"/)
    const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(response.json.id)
    assert.equal(verifyPassword(body.password, row.password_hash), true)
    assert.deepEqual({ id: row.id, videoId: row.video_id, nickname: row.nickname,
      content: row.content, createdAt: row.created_at }, response.json)
    assert.equal(db.isTransaction, false)
    return response.json
  }

  await t.test('anonymous creation preserves exact input and the public list reads the committed five-field comment', async () => {
    const before = snapshot()
    const comment = publicComment(await post(), 1)
    const list = await request('/api/videos/1/comments')
    assert.equal(list.status, 200)
    assert.deepEqual(list.json, { data: [comment], page: 1, limit: 20, total: 1 })
    const after = snapshot()
    for (const table of tables.filter(table => table !== 'comments' && table !== 'sqlite_sequence')) {
      assert.deepEqual(after.rows[table], before.rows[table])
    }
    assert.deepEqual(after.schema, before.schema)
  })

  await t.test('repeat submissions create separate salted records and normalized and maximum parent IDs stay exact', async () => {
    const first = publicComment(await post('0001'), 1)
    const second = publicComment(await post(), 1)
    assert.notEqual(first.id, second.id)
    const hashes = [first, second].map(comment => db.prepare('SELECT password_hash FROM comments WHERE id = ?').get(comment.id).password_hash)
    assert.notEqual(hashes[0], hashes[1])
    publicComment(await post(2), 2)
    const boundary = { nickname: '😀'.repeat(20), password: '😀'.repeat(30), content: '😀'.repeat(500) }
    publicComment(await post(Number.MAX_SAFE_INTEGER, boundary, { 'X-Visitor-Id': 'unused-invalid-visitor' }), Number.MAX_SAFE_INTEGER, boundary)
  })

  await t.test('preflight runs outside and the final parent lookup and insert share one committed IMMEDIATE transaction', async subtest => {
    const commands = []
    const reads = []
    const prepare = db.prepare.bind(db)
    const exec = db.exec.bind(db)
    const observed = subtest.mock.method(db, 'prepare', sql => {
      const statement = prepare(sql)
      const get = statement.get.bind(statement)
      subtest.mock.method(statement, 'get', (...args) => {
        reads.push({ sql, active: db.isTransaction })
        return get(...args)
      })
      return statement
    })
    const transaction = subtest.mock.method(db, 'exec', sql => { commands.push(sql); return exec(sql) })
    let response
    try {
      response = await post()
      assert.equal(response.status, 201)
      assert.deepEqual(commands, ['BEGIN IMMEDIATE', 'COMMIT'])
      assert.equal(reads.length, 3)
      assert.deepEqual(reads.map(read => read.active), [false, true, true])
      assert.ok(reads[0].sql.startsWith('SELECT id FROM videos'))
      assert.ok(reads[1].sql.startsWith('SELECT id FROM videos'))
      assert.ok(reads[2].sql.startsWith('INSERT INTO comments'))
    } finally {
      observed.mock.restore()
      transaction.mock.restore()
    }
    publicComment(response, 1)
  })

  await t.test('deletion committed after preflight is rechecked and returns 404 without inserting a comment', async subtest => {
    const writer = openExistingDatabase(databasePath)
    const exec = db.exec.bind(db)
    let deleted
    const fault = subtest.mock.method(db, 'exec', sql => {
      if (sql === 'BEGIN IMMEDIATE' && !deleted) {
        writer.prepare('DELETE FROM videos WHERE id = ?').run(3)
        deleted = snapshot()
      }
      return exec(sql)
    })
    try {
      const response = await post(3)
      assert.equal(response.status, 404)
      assert.deepEqual(response.json, { code: 'NOT_FOUND', message: '영상을 찾을 수 없습니다.', fields: {} })
    } finally {
      fault.mock.restore()
      writer.close()
    }
    assert.ok(deleted)
    assert.equal(db.isTransaction, false)
    assert.deepEqual(snapshot(), deleted)
  })

  await t.test('parent, post-insert and commit errors return a fixed 500, roll back and permit a later successful creation', async subtest => {
    const log = subtest.mock.method(console, 'error', () => {})
    for (const stage of ['parent', 'insert', 'commit']) {
      const before = snapshot()
      const failure = Object.assign(new Error('private-password-hash-SQL-path'), { status: 404, code: 'NOT_FOUND' })
      const prepare = db.prepare.bind(db)
      const exec = db.exec.bind(db)
      let reached = false
      const prepared = subtest.mock.method(db, 'prepare', sql => {
        const statement = prepare(sql)
        if ((stage === 'parent' && db.isTransaction && sql.startsWith('SELECT id FROM videos')) ||
            (stage === 'insert' && sql.startsWith('INSERT INTO comments'))) {
          const get = statement.get.bind(statement)
          subtest.mock.method(statement, 'get', (...args) => {
            assert.equal(db.isTransaction, true)
            if (stage === 'insert') get(...args)
            reached = true
            throw failure
          })
        }
        return statement
      })
      const transaction = subtest.mock.method(db, 'exec', sql => {
        if (stage === 'commit' && sql === 'COMMIT') { reached = true; throw failure }
        return exec(sql)
      })
      try {
        const response = await post()
        assert.equal(response.status, 500)
        assert.deepEqual(response.json, internal)
        assert.equal(response.headers['set-cookie'], undefined)
        assert.equal(reached, true)
      } finally {
        prepared.mock.restore()
        transaction.mock.restore()
      }
      assert.equal(db.isOpen, true)
      assert.equal(db.isTransaction, false)
      assert.deepEqual(snapshot(), before)
      publicComment(await post(), 1)
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR'], ['INTERNAL_ERROR'], ['INTERNAL_ERROR']])
  })
})
