import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { openExistingDatabase } from '../../src/db/connection.js'
import { hashPassword } from '../../src/lib/password.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const password = ' 12 '
const passwordHash = hashPassword(password)
const replacementHash = hashPassword('5678')
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']
const internal = { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} }

test('public comment DELETE returns an empty 204 only after conditional deletion commits', { timeout: 30000 }, async t => {
  const previous = process.env.COMMENT_DELETE_MAX
  process.env.COMMENT_DELETE_MAX = '100'
  t.after(() => {
    if (previous === undefined) delete process.env.COMMENT_DELETE_MAX
    else process.env.COMMENT_DELETE_MAX = previous
  })
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const db = getDb()
  const fixture = insertMinimalFixture(db)
  db.prepare('UPDATE comments SET password_hash = ? WHERE id = ?').run(passwordHash, fixture.commentId)
  const otherVideo = db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)').run('Other parent', 'unused-path').lastInsertRowid
  function addComment(videoId = fixture.videoId) {
    return db.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)')
      .run(videoId, 'Author', passwordHash, 'Comment').lastInsertRowid
  }
  const preservedId = addComment()
  addComment(otherVideo)
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  const remove = (id, body = { password }) => request(`/api/comments/${id}`, {
    method: 'DELETE', body, headers: { 'X-Visitor-Id': 'unused-invalid-visitor' },
  })
  function deleted(response, id) {
    assert.equal(response.status, 204)
    assert.equal(response.text, '')
    assert.equal(response.json, null)
    assert.equal(response.headers['content-type'], undefined)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.equal(response.headers['retry-after'], undefined)
    assert.equal(db.isOpen, true)
    assert.equal(db.isTransaction, false)
    assert.equal(db.prepare('SELECT id FROM comments WHERE id = ?').get(id), undefined)
  }
  function onlyRemoved(before, id) {
    const after = snapshot()
    assert.deepEqual(after.rows.comments, before.rows.comments.filter(row => row.id !== id))
    for (const table of tables.filter(table => table !== 'comments')) assert.deepEqual(after.rows[table], before.rows[table])
    assert.deepEqual(after.schema, before.schema)
  }

  await t.test('anonymous deletion returns no body and preserves all other data while the public list reflects removal', async () => {
    const before = snapshot()
    deleted(await remove(fixture.commentId), fixture.commentId)
    onlyRemoved(before, fixture.commentId)
    const list = await request(`/api/videos/${fixture.videoId}/comments`)
    assert.equal(list.status, 200)
    assert.equal(list.json.total, 1)
    assert.deepEqual(list.json.data.map(comment => comment.id), [preservedId])
    const repeated = await remove(fixture.commentId)
    assert.equal(repeated.status, 404)
    assert.deepEqual(repeated.json, { code: 'NOT_FOUND', message: '댓글을 찾을 수 없습니다.', fields: {} })
  })

  await t.test('incorrect credentials do not change data and normalized IDs use only server-verified credentials', async () => {
    const id = addComment()
    const before = snapshot()
    const wrong = await remove(id, { password: 'wrong-password', passwordHash, verifiedCommentDeleteTarget: { id, passwordHash } })
    assert.equal(wrong.status, 403)
    assert.deepEqual(wrong.json, { code: 'COMMENT_PASSWORD_MISMATCH', message: '비밀번호가 일치하지 않습니다.', fields: {} })
    assert.deepEqual(snapshot(), before)
    deleted(await remove('000' + id, { password, id: 999, passwordHash: 'forged' }), id)
    onlyRemoved(before, id)
  })

  await t.test('credential lookup is outside the transaction and exact conditional deletion commits inside one IMMEDIATE boundary', async subtest => {
    const id = addComment()
    const commands = []
    const queries = []
    const prepare = db.prepare.bind(db)
    const exec = db.exec.bind(db)
    const observed = subtest.mock.method(db, 'prepare', sql => {
      const statement = prepare(sql)
      const method = sql.startsWith('DELETE FROM comments') ? 'run' : 'get'
      const original = statement[method].bind(statement)
      subtest.mock.method(statement, method, (...args) => {
        queries.push({ sql, args, active: db.isTransaction })
        return original(...args)
      })
      return statement
    })
    const transaction = subtest.mock.method(db, 'exec', sql => { commands.push(sql); return exec(sql) })
    let response
    try {
      response = await remove(id)
      assert.equal(response.status, 204)
      assert.deepEqual(commands, ['BEGIN IMMEDIATE', 'COMMIT'])
      assert.deepEqual(queries, [
        { sql: 'SELECT id, password_hash FROM comments WHERE id = ?', args: [id], active: false },
        { sql: 'DELETE FROM comments WHERE id = ? AND password_hash = ?', args: [id, passwordHash], active: true },
      ])
    } finally {
      observed.mock.restore()
      transaction.mock.restore()
    }
    deleted(response, id)
  })

  await t.test('a target deleted or changed after verification returns 404 or 403 and protects the competing state', async subtest => {
    for (const kind of ['deleted', 'changed-hash']) {
      const id = addComment()
      const writer = openExistingDatabase(databasePath)
      const exec = db.exec.bind(db)
      let competingState
      const race = subtest.mock.method(db, 'exec', sql => {
        if (sql === 'BEGIN IMMEDIATE' && !competingState) {
          if (kind === 'deleted') writer.prepare('DELETE FROM comments WHERE id = ?').run(id)
          else writer.prepare('UPDATE comments SET password_hash = ? WHERE id = ?').run(replacementHash, id)
          competingState = snapshot()
        }
        return exec(sql)
      })
      try {
        const response = await remove(id)
        assert.equal(response.status, kind === 'deleted' ? 404 : 403)
        assert.deepEqual(response.json, kind === 'deleted' ?
          { code: 'NOT_FOUND', message: '댓글을 찾을 수 없습니다.', fields: {} } :
          { code: 'COMMENT_PASSWORD_MISMATCH', message: '비밀번호가 일치하지 않습니다.', fields: {} })
      } finally {
        race.mock.restore()
        writer.close()
      }
      assert.ok(competingState)
      assert.equal(db.isTransaction, false)
      assert.deepEqual(snapshot(), competingState)
    }
  })

  await t.test('post-delete and commit failures cannot send 204 and roll back before a later request recovers', async subtest => {
    const log = subtest.mock.method(console, 'error', () => {})
    for (const stage of ['delete', 'commit']) {
      const id = addComment()
      const before = snapshot()
      const failure = Object.assign(new Error('private-password-hash-SQL-path'), { status: 404, code: 'NOT_FOUND' })
      const prepare = db.prepare.bind(db)
      const exec = db.exec.bind(db)
      let reached = false
      const prepared = subtest.mock.method(db, 'prepare', sql => {
        const statement = prepare(sql)
        if (stage === 'delete' && sql.startsWith('DELETE FROM comments')) {
          const run = statement.run.bind(statement)
          subtest.mock.method(statement, 'run', (...args) => {
            assert.equal(db.isTransaction, true)
            const result = run(...args)
            assert.equal(result.changes, 1)
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
        const response = await remove(id)
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
      deleted(await remove(id), id)
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR'], ['INTERNAL_ERROR']])
  })

  await t.test('a silent storage veto returns a safe 500 and preserves the target until deletion becomes possible', async subtest => {
    const id = addComment()
    db.exec('CREATE TRIGGER test_api_delete_ignore BEFORE DELETE ON comments BEGIN SELECT RAISE(IGNORE); END')
    const before = snapshot()
    const log = subtest.mock.method(console, 'error', () => {})
    try {
      const response = await remove(id)
      assert.equal(response.status, 500)
      assert.deepEqual(response.json, internal)
      assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
      assert.deepEqual(snapshot(), before)
    } finally {
      db.exec('DROP TRIGGER test_api_delete_ignore')
    }
    deleted(await remove(id), id)
  })

  await t.test('the maximum safe comment ID is deleted exactly and a repeat request remains a comment-specific 404', async () => {
    const id = Number.MAX_SAFE_INTEGER
    db.prepare('INSERT INTO comments (id, video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?, ?)')
      .run(id, fixture.videoId, 'Boundary author', passwordHash, 'Boundary comment')
    const before = snapshot()
    deleted(await remove(String(id)), id)
    onlyRemoved(before, id)
    const repeated = await remove(id)
    assert.equal(repeated.status, 404)
    assert.deepEqual(repeated.json, { code: 'NOT_FOUND', message: '댓글을 찾을 수 없습니다.', fields: {} })
  })
})
