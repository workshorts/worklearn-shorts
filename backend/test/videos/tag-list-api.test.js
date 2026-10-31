import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('the public tags GET exposes the complete name-ordered array and uses the shared error boundary', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  let expected

  function snapshot() {
    return {
      rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
      schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
      hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
    }
  }

  async function assertTags(data, { query = '', ...options } = {}) {
    const before = snapshot()
    const response = await request('/api/tags' + query, options)
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.deepEqual(response.json, { data })
    assert.deepEqual(snapshot(), before)
    assert.equal(database.isOpen, true)
    assert.equal(database.isTransaction, false)
  }

  await t.test('an empty table returns 200 with only an empty data array', async () => {
    await assertTags([])
  })

  await t.test('linked and unlinked tags use the existing query order without pagination or a fixed tag limit', async () => {
    const fixture = insertMinimalFixture(database)
    const ids = new Map([['Fixture tag', fixture.tagId]])
    const insert = database.prepare('INSERT INTO tags (name) VALUES (?)')
    for (const name of ['엑셀', '개발', 'Alpha', '기획/PM', '데이터 분석', '비즈니스 매너', '업무자동화', '준비 중']) {
      ids.set(name, insert.run(name).lastInsertRowid)
    }
    database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(fixture.videoId, ids.get('개발'))
    expected = ['Alpha', 'Fixture tag', '개발', '기획/PM', '데이터 분석', '비즈니스 매너', '업무자동화', '엑셀', '준비 중']
      .map(name => ({ id: ids.get(name), name }))
    database.exec('PRAGMA query_only = ON')
    try {
      await assertTags(expected)
    } finally {
      database.exec('PRAGMA query_only = OFF')
    }
  })

  await t.test('anonymous access needs no admin session or visitor header and page parameters do not truncate tags', async () => {
    await assertTags(expected, { query: '?page=2&limit=1',
      headers: { Origin: 'https://other.example.test' }, cookie: 'admin_session=invalid',
    })
  })

  await t.test('new tags, renamed display names and deletions are visible on the next GET with exact IDs', async () => {
    const id = Number.MAX_SAFE_INTEGER
    database.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(id, '가나다')
    await assertTags([...expected.slice(0, 2), { id, name: '가나다' }, ...expected.slice(2)])
    database.prepare('UPDATE tags SET name = ? WHERE id = ?').run('Aardvark', id)
    await assertTags([{ id, name: 'Aardvark' }, ...expected])
    database.prepare('DELETE FROM tags WHERE id = ?').run(id)
    await assertTags(expected)
  })

  await t.test('database failures return one safe 500 without leaking details and a later GET recovers', async subtest => {
    const before = snapshot()
    const log = subtest.mock.method(console, 'error', () => {})
    const fault = subtest.mock.method(database, 'prepare', () => {
      throw new Error('SELECT private_password_hash FROM C:/private/app.db with private-session')
    })
    try {
      const response = await request('/api/tags')
      assert.equal(response.status, 500)
      assert.deepEqual(response.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
      assert.equal(response.headers['set-cookie'], undefined)
      assert.doesNotMatch(response.text, /SELECT|private|password_hash|app\.db|stack/)
    } finally {
      fault.mock.restore()
    }
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['INTERNAL_ERROR']])
    assert.deepEqual(snapshot(), before)
    await assertTags(expected)
  })

  await t.test('unimplemented tag detail and write paths retain the shared 404 instead of becoming public write endpoints', async () => {
    const before = snapshot()
    for (const [path, method] of [['/api/tags/1', 'GET'], ['/api/tags', 'POST'], ['/api/tags/1', 'DELETE']]) {
      const response = await request(path, { method })
      assert.equal(response.status, 404)
      assert.equal(response.json.code, 'NOT_FOUND')
      assert.deepEqual(response.json.fields, {})
    }
    assert.deepEqual(snapshot(), before)
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
  })
})
