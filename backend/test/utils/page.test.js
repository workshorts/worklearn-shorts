import assert from 'node:assert/strict'
import { parse as parseQuery } from 'node:querystring'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { parsePage } from '../../src/utils/pagination.js'

function assertInvalid(value) {
  assert.throws(() => parsePage(value), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 400)
    assert.equal(error.code, 'VALIDATION_ERROR')
    assert.equal(error.message, '입력값을 확인하세요.')
    assert.deepEqual(error.fields, { page: '페이지는 1 이상 9007199254740991 이하의 정수로 입력하세요.' })
    assert.deepEqual(error.headers, {})
    return true
  })
}

test('page parsing defaults only omitted values and accepts positive decimal strings through the safe boundary', () => {
  assert.equal(parsePage(), 1)
  assert.equal(parsePage(undefined), 1)
  for (const [input, expected] of [['1', 1], ['2', 2], ['0002', 2], ['2147483648', 2147483648],
    ['9007199254740990', 9007199254740990], ['9007199254740991', 9007199254740991],
    ['00009007199254740991', 9007199254740991]]) {
    const page = parsePage(input)
    assert.equal(page, expected)
    assert.equal(typeof page, 'number')
    assert.equal(Number.isSafeInteger(page), true)
  }
})

test('page parsing rejects zero, signs, decimals, non-decimal formats and imprecise integers', () => {
  for (const input of ['0', '000', '-0', '-1', '+1', '1.0', '1.5', '.5', '1.', '1e2', '1E2',
    '0x10', '0b10', '0o10', 'NaN', 'Infinity', '1n', '9007199254740992', '9007199254740993',
    '0009007199254740993', '9223372036854775807', '9'.repeat(512)]) {
    assertInvalid(input)
  }
})

test('page parsing rejects empty, whitespace, partial and non-ASCII strings rather than applying the default', () => {
  for (const input of ['', ' ', ' 1', '1 ', '\t1', '1\t', '1\n', '1\r\n', '\ufeff1',
    '1\u00a0', '1abc', '1,2', '1_000', '１', '١', '−1', '1\0', '1?limit=20', '1#fragment']) {
    assertInvalid(input)
  }
})

test('page parsing rejects provided non-string values without invoking conversion hooks', () => {
  let conversions = 0
  const object = {
    [Symbol.toPrimitive]() { conversions += 1; return '1' },
    toString() { conversions += 1; return '1' },
    valueOf() { conversions += 1; return 1 }
  }
  for (const input of [null, 1, 0, -1, 1.5, Number.NaN, Infinity, true, false,
    1n, Symbol('page'), [], ['1'], ['1', '2'], {}, new String('1'), object]) {
    assertInvalid(input)
  }
  assert.equal(conversions, 0)
})

test('query parsing distinguishes an omitted page from blank or repeated parameters before page validation', () => {
  assert.equal(parsePage(parseQuery('limit=20').page), 1)
  assert.equal(parsePage(parseQuery('page=%30%30%32&limit=20').page), 2)
  for (const query of ['page', 'page=', 'page=%20', 'page=+1', 'page=%2B1', 'page=1&page=2', 'page=1&page=1']) {
    assertInvalid(parseQuery(query).page)
  }
})

test('page validation errors expose the fixed page field without copying input into the response', () => {
  const input = "private-page-secret C:/private/data.db ' OR 1=1 --"
  assert.throws(() => parsePage(input), error => {
    const response = { code: error.code, message: error.message, fields: error.fields }
    assert.deepEqual(Object.keys(response).sort(), ['code', 'fields', 'message'])
    assert.deepEqual(Object.keys(response.fields), ['page'])
    for (const value of [input, 'private-page-secret', 'C:/private/data.db', 'OR 1=1']) {
      assert.equal(JSON.stringify(response).includes(value), false)
    }
    assert.equal(error.cause, undefined)
    return true
  })
})
