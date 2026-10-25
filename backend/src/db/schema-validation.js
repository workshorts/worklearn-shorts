// Keep this contract independent of schema.sql so incomplete DDL cannot validate itself.
const tableColumns = {
  admins: ['id', 'username', 'password_hash', 'created_at'],
  videos: ['id', 'title', 'description', 'video_path', 'thumbnail_path', 'created_at', 'updated_at'],
  tags: ['id', 'name'],
  courses: ['id', 'name', 'description', 'created_at', 'updated_at'],
  course_videos: ['course_id', 'video_id', 'sort_order'],
  video_tags: ['video_id', 'tag_id'],
  video_views: ['video_id', 'visitor_id', 'created_at'],
  video_likes: ['video_id', 'visitor_id', 'created_at'],
  comments: ['id', 'video_id', 'nickname', 'password_hash', 'content', 'created_at'],
  quizzes: ['id', 'video_id', 'question', 'created_at', 'updated_at'],
  quiz_options: ['id', 'quiz_id', 'content', 'sort_order', 'is_correct']
}

const integerColumns = new Set(['id', 'video_id', 'course_id', 'tag_id', 'quiz_id', 'sort_order', 'is_correct'])
const utcDefault = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
const columnDefaults = {
  description: "''", thumbnail_path: 'NULL', is_correct: '0',
  created_at: utcDefault, updated_at: utcDefault
}
const compositeKeys = {
  course_videos: ['course_id', 'video_id'],
  video_tags: ['video_id', 'tag_id'],
  video_views: ['video_id', 'visitor_id'],
  video_likes: ['video_id', 'visitor_id']
}
const uniqueKeys = {
  admins: [['username']], course_videos: [['course_id', 'sort_order']],
  quizzes: [['video_id']], quiz_options: [['quiz_id', 'sort_order']]
}
const foreignKeys = {
  course_videos: [['course_id', 'courses'], ['video_id', 'videos']],
  video_tags: [['video_id', 'videos'], ['tag_id', 'tags']],
  video_views: [['video_id', 'videos']], video_likes: [['video_id', 'videos']],
  comments: [['video_id', 'videos']], quizzes: [['video_id', 'videos']],
  quiz_options: [['quiz_id', 'quizzes']]
}
const namedIndexes = {
  idx_tags_name_normalized: {
    table: 'tags', partial: 0, columns: [null],
    sql: 'CREATE UNIQUE INDEX idx_tags_name_normalized ON tags (normalize_tag_name(name))'
  },
  idx_quiz_options_one_correct: {
    table: 'quiz_options', partial: 1, columns: ['quiz_id'],
    sql: 'CREATE UNIQUE INDEX idx_quiz_options_one_correct ON quiz_options (quiz_id) WHERE is_correct = 1'
  }
}

function requireSchema(condition, reason) {
  if (!condition) {
    const error = new Error(`Database schema verification failed: ${reason}.`)
    error.code = 'INVALID_DATABASE_SCHEMA'
    throw error
  }
}

function equalValues(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function indexColumns(database, indexName) {
  const rows = database.prepare(
    'SELECT name, "desc", coll FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno'
  ).all(indexName)
  requireSchema(rows.every(row => row.desc === 0 && row.coll === 'BINARY'), 'unexpected index ordering or collation')
  return rows.map(row => row.name)
}

function canonicalIndexSql(sql) {
  // These two fixed index expressions contain no string literals.
  return sql.trim().replace(/;$/, '').replace(/\s+/g, '').toLowerCase()
}

export function verifyDatabaseSchema(database) {
  if (!database.isOpen) {
    throw new Error('Database connection is closed.')
  }

  const tables = database.prepare(
    "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name"
  ).all()
  requireSchema(equalValues(tables.map(row => row.name), Object.keys(tableColumns).sort()), 'unexpected business tables')
  requireSchema(!database.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('view', 'trigger') LIMIT 1").get(), 'unexpected view or trigger')

  let columnCount = 0
  for (const table of tables) {
    const names = tableColumns[table.name]
    const primaryKey = compositeKeys[table.name] ?? ['id']
    const columns = database.prepare('SELECT * FROM pragma_table_xinfo(?) ORDER BY cid').all(table.name)
    requireSchema(equalValues(columns.map(row => row.name), names), `unexpected columns in ${table.name}`)
    columnCount += columns.length

    for (const column of columns) {
      const type = integerColumns.has(column.name) ? 'INTEGER' : 'TEXT'
      const nullable = table.name === 'videos' && column.name === 'thumbnail_path'
      const defaultValue = columnDefaults[column.name] ?? null
      requireSchema(
        column.type === type && column.notnull === (nullable ? 0 : 1) &&
        column.dflt_value === defaultValue && column.pk === primaryKey.indexOf(column.name) + 1 &&
        column.hidden === 0,
        `invalid column definition in ${table.name}`
      )
    }
    if (primaryKey.length === 1) {
      requireSchema(/\bAUTOINCREMENT\b/i.test(table.sql), `missing AUTOINCREMENT in ${table.name}`)
    }

    const references = database.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(table.name)
    requireSchema(
      references.every(row => row.seq === 0 && row.to === 'id' &&
        row.on_delete === 'CASCADE' && row.on_update === 'NO ACTION' && row.match === 'NONE'),
      `invalid foreign key in ${table.name}`
    )
    const actualReferences = references.map(row => `${row.from}:${row.table}`).sort()
    const expectedReferences = (foreignKeys[table.name] ?? []).map(([column, parent]) => `${column}:${parent}`).sort()
    requireSchema(equalValues(actualReferences, expectedReferences), `unexpected foreign keys in ${table.name}`)

    const indexes = database.prepare('SELECT * FROM pragma_index_list(?)').all(table.name)
    const primaryIndexes = indexes.filter(index => index.origin === 'pk')
    requireSchema(primaryIndexes.length === (primaryKey.length > 1 ? 1 : 0), `invalid primary key index in ${table.name}`)
    for (const index of primaryIndexes) {
      requireSchema(equalValues(indexColumns(database, index.name), primaryKey), `invalid primary key order in ${table.name}`)
    }
    const ordinaryUnique = indexes.filter(index => index.unique === 1 && index.origin !== 'pk' && !Object.hasOwn(namedIndexes, index.name))
    requireSchema(ordinaryUnique.every(index => index.partial === 0), `unexpected partial unique index in ${table.name}`)
    const actualUnique = ordinaryUnique.map(index => JSON.stringify(indexColumns(database, index.name))).sort()
    const expectedUnique = (uniqueKeys[table.name] ?? []).map(columns => JSON.stringify(columns)).sort()
    requireSchema(equalValues(actualUnique, expectedUnique), `unexpected unique keys in ${table.name}`)

    for (const [name, expected] of Object.entries(namedIndexes)) {
      if (expected.table !== table.name) continue
      const index = indexes.find(row => row.name === name)
      requireSchema(index?.unique === 1 && index.partial === expected.partial, `invalid required index ${name}`)
      requireSchema(equalValues(indexColumns(database, name), expected.columns), `invalid required index columns ${name}`)
      const definition = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?").get(name)
      requireSchema(typeof definition?.sql === 'string' &&
        canonicalIndexSql(definition.sql) === canonicalIndexSql(expected.sql), `invalid required index expression ${name}`)
    }
  }

  requireSchema(database.prepare('PRAGMA foreign_keys').get()?.foreign_keys === 1, 'foreign keys are disabled')
  requireSchema(database.prepare('PRAGMA foreign_key_check').all().length === 0, 'foreign key violations')
  return { tableCount: tables.length, columnCount }
}
