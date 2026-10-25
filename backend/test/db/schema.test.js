import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabaseContext } from '../helpers/database-context.js'

const utcDefault = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

// Independent specification: [name, type, notNull, defaultSql, primaryKeyPosition].
// Do not import expected definitions from schema.sql or the production validator.
const expectedColumns = {
  admins: [
    ['id', 'INTEGER', 1, null, 1],
    ['username', 'TEXT', 1, null, 0],
    ['password_hash', 'TEXT', 1, null, 0],
    ['created_at', 'TEXT', 1, utcDefault, 0]
  ],
  videos: [
    ['id', 'INTEGER', 1, null, 1],
    ['title', 'TEXT', 1, null, 0],
    ['description', 'TEXT', 1, "''", 0],
    ['video_path', 'TEXT', 1, null, 0],
    ['thumbnail_path', 'TEXT', 0, 'NULL', 0],
    ['created_at', 'TEXT', 1, utcDefault, 0],
    ['updated_at', 'TEXT', 1, utcDefault, 0]
  ],
  tags: [
    ['id', 'INTEGER', 1, null, 1],
    ['name', 'TEXT', 1, null, 0]
  ],
  courses: [
    ['id', 'INTEGER', 1, null, 1],
    ['name', 'TEXT', 1, null, 0],
    ['description', 'TEXT', 1, "''", 0],
    ['created_at', 'TEXT', 1, utcDefault, 0],
    ['updated_at', 'TEXT', 1, utcDefault, 0]
  ],
  course_videos: [
    ['course_id', 'INTEGER', 1, null, 1],
    ['video_id', 'INTEGER', 1, null, 2],
    ['sort_order', 'INTEGER', 1, null, 0]
  ],
  video_tags: [
    ['video_id', 'INTEGER', 1, null, 1],
    ['tag_id', 'INTEGER', 1, null, 2]
  ],
  video_views: [
    ['video_id', 'INTEGER', 1, null, 1],
    ['visitor_id', 'TEXT', 1, null, 2],
    ['created_at', 'TEXT', 1, utcDefault, 0]
  ],
  video_likes: [
    ['video_id', 'INTEGER', 1, null, 1],
    ['visitor_id', 'TEXT', 1, null, 2],
    ['created_at', 'TEXT', 1, utcDefault, 0]
  ],
  comments: [
    ['id', 'INTEGER', 1, null, 1],
    ['video_id', 'INTEGER', 1, null, 0],
    ['nickname', 'TEXT', 1, null, 0],
    ['password_hash', 'TEXT', 1, null, 0],
    ['content', 'TEXT', 1, null, 0],
    ['created_at', 'TEXT', 1, utcDefault, 0]
  ],
  quizzes: [
    ['id', 'INTEGER', 1, null, 1],
    ['video_id', 'INTEGER', 1, null, 0],
    ['question', 'TEXT', 1, null, 0],
    ['created_at', 'TEXT', 1, utcDefault, 0],
    ['updated_at', 'TEXT', 1, utcDefault, 0]
  ],
  quiz_options: [
    ['id', 'INTEGER', 1, null, 1],
    ['quiz_id', 'INTEGER', 1, null, 0],
    ['content', 'TEXT', 1, null, 0],
    ['sort_order', 'INTEGER', 1, null, 0],
    ['is_correct', 'INTEGER', 1, '0', 0]
  ]
}

function openFreshDatabase(t) {
  const context = createDatabaseContext(t)
  const path = context.path('schema.db')
  context.initialize(path)
  return context.open(path)
}

test('business schema contains exactly the specified eleven tables and forty-five columns', { timeout: 10000 }, t => {
  const database = openFreshDatabase(t)
  const tables = database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name"
  ).all().map(row => row.name)
  assert.deepEqual(tables, Object.keys(expectedColumns).sort())
  assert.equal(tables.length, 11)
  const columnCount = tables.reduce((total, table) => total + database.prepare(
    'SELECT count(*) AS count FROM pragma_table_xinfo(?)'
  ).get(table).count, 0)
  assert.equal(columnCount, 45)
  assert.equal(database.prepare(
    "SELECT count(*) AS count FROM sqlite_schema WHERE type IN ('view', 'trigger')"
  ).get().count, 0)
})

for (const [table, columns] of Object.entries(expectedColumns)) {
  test(`${table} column types, nullability, defaults and primary keys match the specification`, { timeout: 10000 }, t => {
    const database = openFreshDatabase(t)
    const actual = database.prepare(
      'SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid'
    ).all(table).map(row => [row.cid, row.name, row.type, row.notnull, row.dflt_value, row.pk, row.hidden])
    assert.deepEqual(actual, columns.map((column, index) => [index, ...column, 0]))

    if (columns[0][0] === 'id') {
      const definition = database.prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?"
      ).get(table)
      assert.match(definition.sql, /\bAUTOINCREMENT\b/i)
    }
  })
}
