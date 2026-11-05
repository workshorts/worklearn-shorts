import assert from 'node:assert/strict'
import test from 'node:test'
import { readCommentLimitConfig } from '../../src/config/comment-limits.js'

const defaults = { create: { max: 5, windowMs: 60000 }, delete: { max: 10, windowMs: 900000 } }
const names = ['COMMENT_CREATE_MAX', 'COMMENT_CREATE_WINDOW_SECONDS', 'COMMENT_DELETE_MAX', 'COMMENT_DELETE_WINDOW_SECONDS']

test('missing comment settings use independent creation and deletion defaults', () => {
  assert.deepEqual(readCommentLimitConfig({}), defaults)
})

test('each supplied setting changes only its own quota or window', () => {
  const values = [7, 20, 9, 30]
  for (const [index, name] of names.entries()) {
    const expected = structuredClone(defaults)
    const bucket = index < 2 ? expected.create : expected.delete
    bucket[index % 2 === 0 ? 'max' : 'windowMs'] = values[index] * (index % 2 === 0 ? 1 : 1000)
    assert.deepEqual(readCommentLimitConfig({ [name]: String(values[index]) }), expected)
  }
})

test('whole decimal boundaries and leading zeros produce exact milliseconds without timer overflow', () => {
  const minimum = Object.fromEntries(names.map(name => [name, '0001']))
  assert.deepEqual(readCommentLimitConfig(minimum), { create: { max: 1, windowMs: 1000 }, delete: { max: 1, windowMs: 1000 } })
  const maximum = { COMMENT_CREATE_MAX: '9007199254740991', COMMENT_DELETE_MAX: '9007199254740991',
    COMMENT_CREATE_WINDOW_SECONDS: '2147483', COMMENT_DELETE_WINDOW_SECONDS: '2147483' }
  assert.deepEqual(readCommentLimitConfig(maximum), {
    create: { max: Number.MAX_SAFE_INTEGER, windowMs: 2147483000 },
    delete: { max: Number.MAX_SAFE_INTEGER, windowMs: 2147483000 },
  })
})

test('invalid supplied values fail instead of disabling limits or leaking configuration input', () => {
  const invalid = ['', '0', '-1', '1.5', '1e2', ' 5', '5 ', '5\n', '１２', 'Infinity', 'NaN',
    '9007199254740992', 'private-config-value', null, true, 5, [], {}, ['5']]
  for (const name of names) {
    for (const value of [...invalid, ...(name.endsWith('_SECONDS') ? ['2147484'] : [])]) {
      assert.throws(() => readCommentLimitConfig({ [name]: value }), error => {
        assert.ok(error instanceof TypeError)
        assert.equal(error.message, `${name} must be an integer from 1 to ${name.endsWith('_SECONDS') ? 2147483 : Number.MAX_SAFE_INTEGER}.`)
        return true
      })
    }
  }
})

test('configuration and environment remain independent and returned policies cannot be mutated', () => {
  const environment = Object.freeze({ COMMENT_CREATE_MAX: '6', OTHER_SETTING: 'preserved' })
  const first = readCommentLimitConfig(environment)
  assert.throws(() => { first.create.max = 0 }, TypeError)
  assert.throws(() => { first.delete = {} }, TypeError)
  assert.deepEqual(environment, { COMMENT_CREATE_MAX: '6', OTHER_SETTING: 'preserved' })
  assert.deepEqual(first, { create: { max: 6, windowMs: 60000 }, delete: defaults.delete })
  const second = readCommentLimitConfig(environment)
  assert.notEqual(first, second)
  assert.notEqual(first.create, second.create)
  assert.deepEqual(readCommentLimitConfig({}), defaults)
})

test('invalid environment containers are rejected with a fixed message', () => {
  for (const environment of [null, [], '', 1, true]) {
    assert.throws(() => readCommentLimitConfig(environment), {
      name: 'TypeError', message: 'Comment limit configuration requires an environment object.',
    })
  }
})
