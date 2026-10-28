import assert from 'node:assert/strict'
import { parse as parseQuery } from 'node:querystring'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { parseLimit, parsePage } from '../../src/utils/pagination.js'

function assertInvalid(value) {
  assert.throws(() => parseLimit(value), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 400)
    assert.equal(error.code, 'VALIDATION_ERROR')
    assert.equal(error.message, '입력값을 확인하세요.')
    assert.deepEqual(error.fields, { limit: '페이지당 항목 수는 1 이상 50 이하의 정수로 입력하세요.' })
    assert.deepEqual(error.headers, {})
    return true
  })
}

test('limit parsing defaults only omitted values to twenty and accepts every integer from one through fifty', () => {
  assert.equal(parseLimit(), 20)
  assert.equal(parseLimit(undefined), 20)
  for (let expected = 1; expected <= 50; expected += 1) {
    assert.equal(parseLimit(String(expected)), expected)
    assert.equal(parseLimit(`000${expected}`), expected)
  }
  assert.equal(parseLimit(), 20)
  assert.equal(parsePage(), 1)
})

test('limit parsing rejects out-of-range values and alternate numeric formats without clamping', () => {
  for (const input of ['0', '000', '51', '00051', '100', '-1', '-0', '+1', '1.0', '1.5',
    '.5', '1.', '1e1', '1E1', '0x10', '0b10', '0o10', 'NaN', 'Infinity', '1n',
    '9007199254740991', '9007199254740993', '9'.repeat(512)]) {
    assertInvalid(input)
  }
})

test('limit parsing rejects empty, whitespace, partial and non-ASCII strings rather than applying the default', () => {
  for (const input of ['', ' ', ' 20', '20 ', '\t20', '20\t', '20\n', '20\r\n', '\ufeff20',
    '20\u00a0', '20abc', '1,2', '2_0', '２０', '٢٠', '−1', '20\0', '20?page=2', '20#fragment']) {
    assertInvalid(input)
  }
})

test('limit parsing rejects provided non-string values without invoking conversion hooks', () => {
  let conversions = 0
  const object = {
    [Symbol.toPrimitive]() { conversions += 1; return '20' },
    toString() { conversions += 1; return '20' },
    valueOf() { conversions += 1; return 20 }
  }
  for (const input of [null, 20, 1, 50, 0, -1, 1.5, Number.NaN, Infinity, true, false,
    20n, Symbol('limit'), [], ['20'], ['20', '20'], {}, new String('20'), object]) {
    assertInvalid(input)
  }
  assert.equal(conversions, 0)
})

test('query parsing keeps page and limit defaults separate and rejects blank or repeated limit parameters', () => {
  assert.equal(parseLimit(parseQuery('page=2').limit), 20)
  const query = parseQuery('page=0002&limit=%30%35%30')
  assert.equal(parsePage(query.page), 2)
  assert.equal(parseLimit(query.limit), 50)
  for (const input of ['limit', 'limit=', 'limit=%20', 'limit=+1', 'limit=%2B1',
    'limit=20&limit=30', 'limit=20&limit=20']) {
    assertInvalid(parseQuery(input).limit)
  }
})

test('limit validation errors expose only the fixed limit field without copying input into the response', () => {
  const input = "private-limit-secret C:/private/data.db ' OR 1=1 --"
  assert.throws(() => parseLimit(input), error => {
    const response = { code: error.code, message: error.message, fields: error.fields }
    assert.deepEqual(Object.keys(response).sort(), ['code', 'fields', 'message'])
    assert.deepEqual(Object.keys(response.fields), ['limit'])
    for (const value of [input, 'private-limit-secret', 'C:/private/data.db', 'OR 1=1']) {
      assert.equal(JSON.stringify(response).includes(value), false)
    }
    assert.equal(error.cause, undefined)
    return true
  })
})
