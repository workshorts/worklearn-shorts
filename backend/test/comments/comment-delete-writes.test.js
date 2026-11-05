import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadCommentDeleteTarget } from '../../src/db/comment-queries.js'
import { deleteVerifiedComment } from '../../src/db/comment-writes.js'
import { withTransaction } from '../../src/db/transaction.js'
import { ApiError } from '../../src/errors.js'
import { hashPassword } from '../../src/lib/password.js'
import { verifyCommentDeletePassword } from '../../src/middleware/verifyCommentDeletePassword.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const passwordHash = hashPassword('1234')
const replacementHash = hashPassword('5678')
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('comment-delete-writes.db')
  context.initialize(path)
  const db = context.open(path)
  const fixture = insertMinimalFixture(db)
  db.prepare('UPDATE comments SET password_hash = ? WHERE id = ?').run(passwordHash, fixture.commentId)
  return { context, path, db, ...fixture }
}

function snapshot(db, path) {
  return {
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }
}

function authorize(db, id, password = '1234') {
  const res = { locals: { commentDeleteRequest: { id, password }, commentDeleteTarget: loadCommentDeleteTarget(db, id) } }
  verifyCommentDeletePassword({}, res, () => {})
  return res.locals.verifiedCommentDeleteTarget
}

function remove(db, candidate) {
  return withTransaction(db, connection => deleteVerifiedComment(connection, candidate), { mode: 'IMMEDIATE' })
}

function failsWith(operation, status, code) {
  assert.throws(operation, error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, status)
    assert.equal(error.code, code)
    assert.deepEqual(error.fields, {})
    assert.deepEqual(error.headers, {})
    return true
  })
}

test('deletion removes only the verified ID while preserving every other row, sequence and schema', t => {
  const { db, context, path, commentId, videoId } = setup(t)
  const otherVideo = db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)').run('Other parent', 'unused-path').lastInsertRowid
  for (const id of [videoId, otherVideo]) {
    db.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)')
      .run(id, 'Other author', passwordHash, 'Preserved comment')
  }
  const verified = authorize(db, commentId)
  let reads = 0
  const candidate = Object.freeze({ id: verified.id,
    get passwordHash() { reads += 1; return reads === 1 ? verified.passwordHash : replacementHash },
    get password() { assert.fail('Deletion must not read plaintext') },
    get unrelated() { assert.fail('Deletion must not read extra fields') } })
  const before = snapshot(db, path)
  assert.equal(remove(db, candidate), undefined)
  assert.equal(reads, 1)
  const after = snapshot(db, path)
  assert.deepEqual(after.rows.comments, before.rows.comments.filter(row => row.id !== commentId))
  for (const table of tables.filter(table => table !== 'comments')) assert.deepEqual(after.rows[table], before.rows[table])
  assert.deepEqual(after.schema, before.schema)
  assert.equal(context.open(path).prepare('SELECT id FROM comments WHERE id = ?').get(commentId), undefined)
  assert.equal(db.isOpen, true)
  assert.equal(db.isTransaction, false)
})

test('deletion requires an open caller transaction before preparing SQL', t => {
  const { db, context, path, commentId } = setup(t)
  const verified = authorize(db, commentId)
  const before = snapshot(db, path)
  const prepared = t.mock.method(db, 'prepare', () => assert.fail('Invalid write contexts must not prepare SQL'))
  try {
    assert.throws(() => deleteVerifiedComment(db, verified), { message: 'Comment deletion requires an active transaction.' })
    db.close()
    assert.throws(() => deleteVerifiedComment(db, verified), { message: 'Database connection is closed.' })
    assert.equal(prepared.mock.callCount(), 0)
  } finally {
    prepared.mock.restore()
  }
  assert.deepEqual(snapshot(context.open(path), path), before)
})

test('invalid verification snapshots cannot reach SQL or end the caller transaction', t => {
  const { db, path, commentId } = setup(t)
  const valid = authorize(db, commentId)
  const invalid = [undefined, null, [], 'private-value', {},
    ...[0, -1, '1', Number.MAX_SAFE_INTEGER + 1, null].map(id => ({ ...valid, id })),
    ...['1234', '', null, valid.passwordHash + '\n', valid.passwordHash.toUpperCase()].map(hash => ({ ...valid, passwordHash: hash }))]
  const before = snapshot(db, path)
  withTransaction(db, connection => {
    const prepared = t.mock.method(connection, 'prepare', () => assert.fail('Invalid verification snapshots must not reach SQL'))
    try {
      for (const value of invalid) {
        assert.throws(() => deleteVerifiedComment(connection, value),
          { name: 'TypeError', message: 'Comment deletion requires a verified ID and password hash.' })
        assert.equal(connection.isTransaction, true)
      }
      assert.equal(prepared.mock.callCount(), 0)
    } finally {
      prepared.mock.restore()
    }
  })
  assert.deepEqual(snapshot(db, path), before)
})

test('a comment or parent deleted after password verification produces 404 without further changes', t => {
  for (const kind of ['comment', 'parent']) {
    const { db, context, path, commentId, videoId } = setup(t)
    const verified = authorize(db, commentId)
    const other = context.open(path)
    if (kind === 'comment') other.prepare('DELETE FROM comments WHERE id = ?').run(commentId)
    else other.prepare('DELETE FROM videos WHERE id = ?').run(videoId)
    const before = snapshot(db, path)
    failsWith(() => remove(db, verified), 404, 'NOT_FOUND')
    assert.deepEqual(snapshot(db, path), before)
    assert.equal(db.isTransaction, false)
  }
})

test('changed credentials or a replacement row cannot be deleted with an old verified snapshot', t => {
  for (const kind of ['changed-hash', 'replacement']) {
    const { db, context, path, commentId, videoId } = setup(t)
    const verified = authorize(db, commentId)
    const other = context.open(path)
    withTransaction(other, connection => {
      if (kind === 'replacement') {
        connection.prepare('DELETE FROM comments WHERE id = ?').run(commentId)
        connection.prepare('INSERT INTO comments (id, video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?, ?)')
          .run(commentId, videoId, 'Replacement author', replacementHash, 'New target')
      } else connection.prepare('UPDATE comments SET password_hash = ? WHERE id = ?').run(replacementHash, commentId)
    })
    const before = snapshot(db, path)
    failsWith(() => remove(db, verified), 403, 'COMMENT_PASSWORD_MISMATCH')
    assert.deepEqual(snapshot(db, path), before)
    assert.equal(db.isTransaction, false)
    assert.equal(remove(db, authorize(db, commentId, '5678')), undefined)
  }
})

test('later operation and commit failures roll back deletion fully and the same connection can retry', t => {
  const { db, path, commentId } = setup(t)
  const verified = authorize(db, commentId)
  const before = snapshot(db, path)
  for (const stage of ['operation', 'commit']) {
    const failure = new Error('Expected deletion rollback')
    const exec = db.exec.bind(db)
    const fault = t.mock.method(db, 'exec', sql => {
      if (stage === 'commit' && sql === 'COMMIT') throw failure
      return exec(sql)
    })
    try {
      assert.throws(() => withTransaction(db, connection => {
        deleteVerifiedComment(connection, verified)
        assert.equal(connection.isTransaction, true)
        assert.equal(connection.prepare('SELECT id FROM comments WHERE id = ?').get(commentId), undefined)
        if (stage === 'operation') throw failure
      }), error => error === failure)
    } finally {
      fault.mock.restore()
    }
    assert.equal(db.isOpen, true)
    assert.equal(db.isTransaction, false)
    assert.deepEqual(snapshot(db, path), before)
  }
  assert.equal(remove(db, verified), undefined)
})

test('native deletion failures remain errors and preserve the target instead of becoming a successful or missing deletion', t => {
  const { db, path, commentId } = setup(t)
  const verified = authorize(db, commentId)
  db.exec("CREATE TRIGGER test_delete_abort BEFORE DELETE ON comments BEGIN SELECT RAISE(ABORT, 'private-native-error'); END")
  const before = snapshot(db, path)
  assert.throws(() => remove(db, verified), error => !(error instanceof ApiError) && error.code === 'ERR_SQLITE_ERROR' && error.errcode === 1811)
  assert.equal(db.isTransaction, false)
  assert.deepEqual(snapshot(db, path), before)
  db.exec('DROP TRIGGER test_delete_abort')
  assert.equal(remove(db, verified), undefined)
})

test('a silent database veto cannot report success when the exact verified row still exists', t => {
  const { db, path, commentId } = setup(t)
  const verified = authorize(db, commentId)
  db.exec('CREATE TRIGGER test_delete_ignore BEFORE DELETE ON comments BEGIN SELECT RAISE(IGNORE); END')
  const before = snapshot(db, path)
  assert.throws(() => remove(db, verified), { message: 'Verified comment deletion did not remove its target.' })
  assert.equal(db.isTransaction, false)
  assert.deepEqual(snapshot(db, path), before)
  db.exec('DROP TRIGGER test_delete_ignore')
  assert.equal(remove(db, verified), undefined)
})

test('the deletion write lock protects the result until commit under rollback and WAL journaling', t => {
  for (const mode of ['DELETE', 'WAL']) {
    const { db, context, path, commentId } = setup(t)
    const verified = authorize(db, commentId)
    assert.equal(db.prepare(`PRAGMA journal_mode = ${mode}`).get().journal_mode, mode.toLowerCase())
    const other = context.open(path)
    other.exec('PRAGMA busy_timeout = 0')
    withTransaction(db, connection => {
      deleteVerifiedComment(connection, verified)
      assert.ok(other.prepare('SELECT id FROM comments WHERE id = ?').get(commentId))
      assert.throws(() => other.prepare('UPDATE comments SET password_hash = ? WHERE id = ?').run(replacementHash, commentId),
        error => error.code === 'ERR_SQLITE_ERROR' && error.errcode === 5)
    }, { mode: 'IMMEDIATE' })
    assert.equal(other.prepare('SELECT id FROM comments WHERE id = ?').get(commentId), undefined)
    failsWith(() => remove(db, verified), 404, 'NOT_FOUND')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  }
})
