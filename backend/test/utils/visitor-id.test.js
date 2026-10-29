import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { withTransaction } from '../../src/db/transaction.js'
import { parseVisitorId } from '../../src/utils/visitor-id.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const base = 'aabbccdd-eeff-4abc-8def-012345abcdef'

function assertInvalid(value) {
  assert.throws(() => parseVisitorId(value), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 400)
    assert.equal(error.code, 'VALIDATION_ERROR')
    assert.equal(error.message, '입력값을 확인하세요.')
    assert.deepEqual(error.fields, { visitorId: '방문자 ID는 올바른 UUID 형식으로 입력하세요.' })
    assert.deepEqual(error.headers, {})
    return true
  })
}

test('visitor IDs accept versions one through eight and all allowed variants in lower, upper and mixed case', () => {
  for (const version of '12345678') {
    for (const variant of '89ab') {
      const lower = `aabbccdd-eeff-${version}abc-${variant}def-012345abcdef`
      const mixed = [...lower].map((character, index) => index % 2 === 0 ? character.toUpperCase() : character).join('')
      for (const input of [lower, lower.toUpperCase(), mixed]) {
        assert.equal(parseVisitorId(input), lower)
        assert.equal(input.length, 36)
      }
    }
  }
})

test('visitor IDs support generated version-four values and existing zero-prefixed fixtures without changing identity', () => {
  const fixtures = ['00000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001']
  for (const input of [...fixtures, randomUUID(), randomUUID()]) {
    assert.equal(parseVisitorId(input), input)
    assert.equal(parseVisitorId(parseVisitorId(input)), input)
  }
})

test('visitor IDs reject disallowed version or variant bits and the Nil and Max sentinel values', () => {
  for (const version of '09abcdef') assertInvalid(base.slice(0, 14) + version + base.slice(15))
  for (const variant of '01234567cdef') assertInvalid(base.slice(0, 19) + variant + base.slice(20))
  assertInvalid('00000000-0000-0000-0000-000000000000')
  assertInvalid('ffffffff-ffff-ffff-ffff-ffffffffffff')
})

test('visitor IDs reject alternate representations, whitespace, duplicate values and malformed full-length characters', () => {
  for (const input of ['', ' ', base.replaceAll('-', ''), `urn:uuid:${base}`, `{${base}}`,
    base.slice(1), base + '0', ' ' + base, base + ' ', '\t' + base, base + '\n', base + '\r\n',
    base + '\0', base + ',' + base, base + ', ' + base, base.replace('-', '_'),
    base.replaceAll('-', '−'), base.replace('a', 'ａ'), base.replace('a', 'а'), base.replace('0', '٠'),
    ' ' + base.slice(1), '\0' + base.slice(1), 'g' + base.slice(1), base.replace('e', '\n')]) {
    assertInvalid(input)
  }
})

test('visitor IDs reject missing and non-string values without invoking conversion hooks', () => {
  let conversions = 0
  const object = {
    [Symbol.toPrimitive]() { conversions += 1; return base },
    toString() { conversions += 1; return base },
    valueOf() { conversions += 1; return base }
  }
  for (const input of [undefined, null, 1, 0, Number.NaN, Infinity, true, false, 1n,
    Symbol('visitorId'), [], [base], [base, base], {}, new String(base), object]) {
    assertInvalid(input)
  }
  assert.equal(conversions, 0)
})

test('visitor ID validation errors contain only the fixed public field and no supplied private details', () => {
  const input = "private-visitor-secret C:/private/data.db ' OR 1=1 --"
  assert.throws(() => parseVisitorId(input), error => {
    const response = { code: error.code, message: error.message, fields: error.fields }
    assert.deepEqual(Object.keys(response).sort(), ['code', 'fields', 'message'])
    assert.deepEqual(Object.keys(response.fields), ['visitorId'])
    for (const value of [input, 'private-visitor-secret', 'C:/private/data.db', 'OR 1=1']) {
      assert.equal(JSON.stringify(response).includes(value), false)
    }
    assert.equal(error.cause, undefined)
    return true
  })
})

test('normalized visitor IDs use one SQLite key for view and like insertion, lookup and deletion', t => {
  const context = createDatabaseContext(t)
  const path = context.path('visitor-id.db')
  context.initialize(path)
  const database = context.open(path)
  const { videoId } = insertMinimalFixture(database)
  for (const table of ['video_views', 'video_likes']) {
    const insert = database.prepare(`INSERT INTO ${table} (video_id, visitor_id) VALUES (?, ?)`)
    withTransaction(database, () => insert.run(videoId, parseVisitorId(base.toUpperCase())))
    const find = database.prepare(`SELECT * FROM ${table} WHERE video_id = ? AND visitor_id = ?`)
    const original = find.get(videoId, base)
    assert.equal(original.visitor_id, base)
    assert.throws(() => withTransaction(database, () => insert.run(videoId, parseVisitorId(base))), {
      code: 'ERR_SQLITE_ERROR', errcode: 1555
    })
    assert.deepEqual(find.get(videoId, parseVisitorId(base.toUpperCase())), original)
    assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table} WHERE video_id = ? AND visitor_id = ?`).get(videoId, base).count, 1)
    const removed = withTransaction(database, () => database.prepare(`DELETE FROM ${table} WHERE video_id = ? AND visitor_id = ?`)
      .run(videoId, parseVisitorId(base.toUpperCase())))
    assert.equal(removed.changes, 1)
    assert.equal(find.get(videoId, base), undefined)
    assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 1)
  }
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})
