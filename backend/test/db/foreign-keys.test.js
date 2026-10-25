import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const missingId = 999999
const cases = [
  {
    table: 'course_videos', column: 'course_id', parent: 'courses',
    values: ids => ({ course_id: ids.extraCourseId, video_id: ids.videoId, sort_order: 1 }),
    key: ids => ({ course_id: ids.courseId, video_id: ids.videoId })
  },
  {
    table: 'course_videos', column: 'video_id', parent: 'videos',
    values: ids => ({ course_id: ids.courseId, video_id: ids.extraVideoId, sort_order: 2 }),
    key: ids => ({ course_id: ids.courseId, video_id: ids.videoId })
  },
  {
    table: 'video_tags', column: 'video_id', parent: 'videos',
    values: ids => ({ video_id: ids.extraVideoId, tag_id: ids.tagId }),
    key: ids => ({ video_id: ids.videoId, tag_id: ids.tagId })
  },
  {
    table: 'video_tags', column: 'tag_id', parent: 'tags',
    values: ids => ({ video_id: ids.videoId, tag_id: ids.extraTagId }),
    key: ids => ({ video_id: ids.videoId, tag_id: ids.tagId })
  },
  {
    table: 'video_views', column: 'video_id', parent: 'videos',
    values: ids => ({ video_id: ids.videoId, visitor_id: '00000000-0000-4000-8000-000000000002' }),
    key: ids => ({ video_id: ids.videoId, visitor_id: ids.visitorId })
  },
  {
    table: 'video_likes', column: 'video_id', parent: 'videos',
    values: ids => ({ video_id: ids.videoId, visitor_id: '00000000-0000-4000-8000-000000000002' }),
    key: ids => ({ video_id: ids.videoId, visitor_id: ids.visitorId })
  },
  {
    table: 'comments', column: 'video_id', parent: 'videos',
    values: ids => ({ video_id: ids.videoId, nickname: 'FK control',
      password_hash: 'test-only-placeholder', content: 'Valid foreign key' }),
    key: ids => ({ id: ids.commentId })
  },
  {
    table: 'quizzes', column: 'video_id', parent: 'videos',
    values: ids => ({ video_id: ids.extraVideoId, question: 'Valid FK question?' }),
    key: ids => ({ id: ids.quizId })
  },
  {
    table: 'quiz_options', column: 'quiz_id', parent: 'quizzes',
    values: ids => ({ quiz_id: ids.quizId, content: 'Valid FK option', sort_order: 3, is_correct: 0 }),
    key: ids => ({ id: ids.incorrectOptionId })
  }
]
const snapshotTables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function snapshotRows(database) {
  return Object.fromEntries(snapshotTables.map(table => [
    table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
  ]))
}

function isForeignKeyFailure(error) {
  // Check the extended SQLite FK code rather than accepting any constraint error.
  assert.equal(error.code, 'ERR_SQLITE_ERROR')
  assert.equal(error.errcode, 787)
  return true
}

for (const { table, column, parent, values, key } of cases) {
  test(`${table}.${column} rejects missing parents on insert and update without changing existing rows`, { timeout: 10000 }, t => {
    const context = createDatabaseContext(t)
    const path = context.path('foreign-keys.db')
    context.initialize(path)
    const database = context.open(path)
    assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
    const ids = insertMinimalFixture(database)
    ids.extraVideoId = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
      .run('Second video', 'videos/fk-control.mp4').lastInsertRowid
    ids.extraCourseId = database.prepare('INSERT INTO courses (name) VALUES (?)')
      .run('Second course').lastInsertRowid
    ids.extraTagId = database.prepare('INSERT INTO tags (name) VALUES (?)')
      .run('Second tag').lastInsertRowid

    const references = database.prepare(
      'SELECT "table" AS parent, "to" AS target FROM pragma_foreign_key_list(?) WHERE "from" = ?'
    ).all(table, column).map(row => ({ ...row }))
    assert.deepEqual(references, [{ parent, target: 'id' }])
    const valid = values(ids)
    const columns = Object.keys(valid)
    const invalid = { ...valid, [column]: missingId }
    assert.equal(database.prepare(`SELECT 1 AS found FROM ${parent} WHERE id = ?`).get(missingId), undefined)
    assert.equal(database.prepare(`SELECT 1 AS found FROM ${parent} WHERE id = ?`).get(valid[column]).found, 1)
    const insert = database.prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    )
    const existingKey = key(ids)
    const where = Object.keys(existingKey).map(name => `${name} = ?`).join(' AND ')
    const existingValues = Object.values(existingKey)
    assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${where}`)
      .get(...existingValues).count, 1)
    const before = snapshotRows(database)

    assert.throws(() => insert.run(...Object.values(invalid)), isForeignKeyFailure)
    assert.deepEqual(snapshotRows(database), before)
    assert.equal(database.isTransaction, false)
    assert.throws(() => database.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${where}`)
      .run(missingId, ...existingValues), isForeignKeyFailure)
    assert.deepEqual(snapshotRows(database), before)
    assert.equal(database.isTransaction, false)

    // Changing only the missing parent to a real one must make the insert valid.
    assert.equal(insert.run(...Object.values(valid)).changes, 1)
    assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, before[table].length + 1)
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
  })
}
