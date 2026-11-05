import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadCommentPage } from '../../src/db/comment-queries.js'
import { withTransaction } from '../../src/db/transaction.js'
import { toCommentDto } from '../../src/lib/comment-dto.js'
import { hashPassword } from '../../src/lib/password.js'
import { createDatabaseContext } from '../helpers/database-context.js'

const keys = ['id', 'videoId', 'nickname', 'content', 'createdAt']
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('private columns, conflicting aliases and serialization hooks never enter the public comment object', () => {
  const row = { id: 7, video_id: 3, nickname: 'Public author', content: 'Public content', created_at: '2000-01-02T03:04:05.006Z',
    videoId: 'private-conflicting-alias', createdAt: 'private-conflicting-time', internal: 'private-metadata' }
  for (const name of ['password', 'password_hash', 'passwordHash', 'toJSON']) {
    Object.defineProperty(row, name, { enumerable: true, get() { assert.fail('Private property must not be read: ' + name) } })
  }
  const dto = toCommentDto(Object.freeze(row))
  assert.deepEqual(Object.keys(dto), keys)
  assert.deepEqual(JSON.parse(JSON.stringify(dto)), {
    id: 7, videoId: 3, nickname: 'Public author', content: 'Public content', createdAt: '2000-01-02T03:04:05.006Z',
  })
  assert.equal(Object.getPrototypeOf(dto), Object.prototype)
})

test('stored text, safe boundary IDs and historical timestamps stay exact and each response owns its public object', () => {
  const row = Object.freeze({ id: Number.MAX_SAFE_INTEGER, video_id: Number.MAX_SAFE_INTEGER,
    nickname: ' 작성자 ', content: ' 첫 줄\n<b>둘째 줄</b> e\u0301 😀 ', created_at: '2001-02-03T04:05:06.007Z' })
  const first = toCommentDto(row)
  const second = toCommentDto(row)
  assert.deepEqual(first, { id: Number.MAX_SAFE_INTEGER, videoId: Number.MAX_SAFE_INTEGER,
    nickname: row.nickname, content: row.content, createdAt: row.created_at })
  assert.notEqual(first, second)
  first.content = 'Changed response only'
  first.password = 'Changed response only'
  assert.equal(second.content, row.content)
  assert.deepEqual(Object.keys(second), keys)
  assert.equal(row.content, ' 첫 줄\n<b>둘째 줄</b> e\u0301 😀 ')
  assert.equal(typeof second.id, 'number')
  assert.equal(typeof second.videoId, 'number')
  assert.equal(typeof second.createdAt, 'string')
})

test('real SQLite rows and public pages map to the same five-field JSON while preserving order and database state', t => {
  const context = createDatabaseContext(t)
  const path = context.path('comment-dto.db')
  context.initialize(path)
  const database = context.open(path)
  database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)').run(1, 'Comment parent', 'unused-path')
  const password = '1234'
  const hash = hashPassword(password)
  const insert = database.prepare('INSERT INTO comments (id, video_id, nickname, password_hash, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  insert.run(1, 1, ' 첫 작성자 ', hash, ' First content\n ', '2000-01-01T00:00:00.000Z')
  insert.run(3, 1, '두 번째', hash, 'Second content', '2001-01-01T00:00:00.000Z')
  insert.run(2, 1, '세 번째', hash, 'Third content', '2001-01-01T00:00:00.000Z')
  function snapshot() {
    return {
      rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
      schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
      hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
    }
  }
  database.exec('PRAGMA query_only = ON')
  const before = snapshot()
  withTransaction(database, connection => {
    const internal = connection.prepare('SELECT * FROM comments WHERE video_id = ? ORDER BY created_at DESC, id DESC').all(1)
    assert.ok(internal.every(row => row.password_hash === hash))
    const complete = internal.map(toCommentDto)
    const collected = []
    for (const page of [1, 2, 3]) {
      const mapped = loadCommentPage(connection, { videoId: 1, page, limit: 2 }).map(toCommentDto)
      assert.deepEqual(mapped, complete.slice((page - 1) * 2, page * 2))
      collected.push(...mapped)
    }
    assert.deepEqual(collected.map(row => row.id), [3, 2, 1])
    assert.deepEqual(collected, complete)
    const json = JSON.stringify(collected)
    assert.equal(json.includes(hash), false)
    assert.equal(json.includes(password), false)
    for (const dto of JSON.parse(json)) {
      assert.deepEqual(Object.keys(dto), keys)
      assert.equal(typeof dto.id, 'number')
      assert.equal(typeof dto.videoId, 'number')
      for (const field of ['nickname', 'content', 'createdAt']) assert.equal(typeof dto[field], 'string')
    }
    assert.equal(connection.isTransaction, true)
  }, { mode: 'DEFERRED' })
  assert.equal(database.isTransaction, false)
  assert.equal(database.isOpen, true)
  assert.deepEqual(snapshot(), before)
})
