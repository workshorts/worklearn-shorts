import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { parseResourceId } from '../../src/utils/resource-id.js'
import { createDatabaseContext } from '../helpers/database-context.js'

function assertInvalid(value) {
  assert.throws(() => parseResourceId(value), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 400)
    assert.equal(error.code, 'VALIDATION_ERROR')
    assert.equal(error.message, '입력값을 확인하세요.')
    assert.deepEqual(error.fields, { id: 'ID는 1 이상 9007199254740991 이하의 정수로 입력하세요.' })
    assert.deepEqual(error.headers, {})
    return true
  })
}

test('resource IDs accept positive decimal strings through the safe integer boundary and normalize leading zeros', () => {
  const cases = [
    ['1', 1], ['42', 42], ['2147483648', 2147483648], ['4294967296', 4294967296],
    ['9007199254740990', 9007199254740990], ['9007199254740991', 9007199254740991],
    ['0001', 1], ['00042', 42], ['00009007199254740991', 9007199254740991]
  ]
  for (const [input, expected] of cases) {
    const id = parseResourceId(input)
    assert.equal(id, expected)
    assert.equal(typeof id, 'number')
    assert.equal(Number.isSafeInteger(id), true)
  }
})

test('resource IDs reject zero, signs, decimals, exponent notation and non-decimal formats', () => {
  for (const input of ['0', '000', '-0', '-1', '+1', '1.0', '1.5', '.5', '1.',
    '1e2', '1E2', '0x10', '0X10', '0b10', '0o10', 'NaN', 'Infinity', '1n']) {
    assertInvalid(input)
  }
})

test('resource IDs reject whitespace, partial parsing, separators and non-ASCII digit representations', () => {
  for (const input of ['', ' ', ' 1', '1 ', '\t1', '1\t', '1\n', '1\r\n', '\ufeff1',
    '1\u00a0', '1abc', '1/2', '1,2', '1_000', '１', '١', '−1', '1\0', '1?other=2', '1#fragment']) {
    assertInvalid(input)
  }
})

test('resource IDs reject unsafe integers without accepting rounded or infinite conversions', () => {
  for (const input of ['9007199254740992', '9007199254740993', '0009007199254740993',
    '9223372036854775807', '18446744073709551615', '9'.repeat(512)]) {
    assertInvalid(input)
  }
})

test('resource IDs reject non-string inputs without invoking conversion hooks', () => {
  let conversions = 0
  const object = {
    [Symbol.toPrimitive]() { conversions += 1; return '1' },
    toString() { conversions += 1; return '1' },
    valueOf() { conversions += 1; return 1 }
  }
  for (const input of [undefined, null, 1, 0, -1, 1.5, Number.NaN, Infinity, true, false,
    1n, Symbol('id'), [], ['1'], {}, new String('1'), object]) {
    assertInvalid(input)
  }
  assert.equal(conversions, 0)
})

test('resource ID errors expose only the fixed public validation message and field', () => {
  const input = "private-id-secret C:/private/data.db ' OR 1=1 --"
  assert.throws(() => parseResourceId(input), error => {
    const response = { code: error.code, message: error.message, fields: error.fields }
    assert.deepEqual(Object.keys(response).sort(), ['code', 'fields', 'message'])
    for (const privateValue of [input, 'private-id-secret', 'C:/private/data.db', 'OR 1=1']) {
      assert.equal(JSON.stringify(response).includes(privateValue), false)
    }
    assert.equal(error.cause, undefined)
    return true
  })
})

test('validated resource IDs bind exactly to SQLite while an absent valid ID remains a lookup concern', t => {
  const context = createDatabaseContext(t)
  const path = context.path('resource-id.db')
  context.initialize(path)
  const database = context.open(path)
  const insert = database.prepare('INSERT INTO videos (id, title, video_path) VALUES (?, ?, ?)')
  insert.run(1, 'First resource', 'test-only-first.mp4')
  insert.run(9007199254740991, 'Boundary resource', 'test-only-boundary.mp4')
  const find = database.prepare('SELECT id, title FROM videos WHERE id = ?')
  assert.equal(find.get(parseResourceId('0001')).title, 'First resource')
  const boundary = find.get(parseResourceId('9007199254740991'))
  assert.equal(boundary.id, 9007199254740991)
  assert.equal(boundary.title, 'Boundary resource')
  assert.equal(find.get(parseResourceId('42')), undefined)
  assert.equal(database.prepare('SELECT count(*) AS count FROM videos').get().count, 2)
})
