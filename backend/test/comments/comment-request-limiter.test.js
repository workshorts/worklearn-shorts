import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { createCommentRequestLimiter } from '../../src/lib/comment-request-limiter.js'

const ip = '192.0.2.1'
const otherIp = '192.0.2.2'

function setup(t) {
  const clock = { now: 10000 }
  const intervals = []
  const interval = globalThis.setInterval
  t.mock.method(Date, 'now', () => clock.now)
  t.mock.method(globalThis, 'setInterval', (callback, milliseconds) => {
    const timer = interval(callback, milliseconds)
    intervals.push({ callback, milliseconds, timer })
    return timer
  })
  // The shared limiter owns process-lifetime unref timers; release only this test's handles.
  t.after(() => intervals.forEach(({ timer }) => clearInterval(timer)))
  return { clock, intervals }
}

function blocked(operation, seconds) {
  assert.throws(operation, error => {
    assert.ok(error instanceof ApiError)
    assert.deepEqual({ status: error.status, code: error.code, message: error.message,
      fields: error.fields, headers: error.headers }, {
      status: 429, code: 'RATE_LIMITED', message: '시도가 너무 많습니다. 잠시 후 다시 시도하세요.',
      fields: {}, headers: { 'Retry-After': String(seconds) },
    })
    assert.equal(error.message.includes(ip), false)
    return true
  })
}

test('default creation and deletion quotas admit their last allowed attempt then throw the shared safe error', t => {
  const { intervals } = setup(t)
  const limiter = createCommentRequestLimiter({})
  for (let index = 0; index < 5; index++) assert.equal(limiter.consumeCreate(ip), undefined)
  blocked(() => limiter.consumeCreate(ip), 60)
  for (let index = 0; index < 10; index++) assert.equal(limiter.consumeDelete(ip), undefined)
  blocked(() => limiter.consumeDelete(ip), 900)
  assert.deepEqual(intervals.map(entry => entry.milliseconds), [60000, 900000])
  assert.ok(intervals.every(entry => entry.timer.hasRef() === false))
  assert.ok(Object.isFrozen(limiter))
})

test('different IPs and operation types retain independent quotas without success resets', t => {
  setup(t)
  const limiter = createCommentRequestLimiter({ COMMENT_CREATE_MAX: '1', COMMENT_DELETE_MAX: '1' })
  limiter.consumeCreate(ip)
  limiter.consumeCreate(otherIp)
  limiter.consumeDelete(ip)
  limiter.consumeDelete(otherIp)
  for (const key of [ip, otherIp]) {
    blocked(() => limiter.consumeCreate(key), 60)
    blocked(() => limiter.consumeDelete(key), 900)
  }
  assert.deepEqual(Object.keys(limiter), ['consumeCreate', 'consumeDelete'])
})

test('retry seconds round upward and denied attempts neither extend the fixed window nor consume its successor', t => {
  const { clock } = setup(t)
  const limiter = createCommentRequestLimiter({ COMMENT_CREATE_MAX: '2', COMMENT_CREATE_WINDOW_SECONDS: '2' })
  limiter.consumeCreate(ip)
  clock.now = 10500
  limiter.consumeCreate(ip)
  blocked(() => limiter.consumeCreate(ip), 2)
  clock.now = 11000
  blocked(() => limiter.consumeCreate(ip), 1)
  clock.now = 11999
  for (let index = 0; index < 20; index++) blocked(() => limiter.consumeCreate(ip), 1)
  clock.now = 12000
  limiter.consumeCreate(ip)
  limiter.consumeCreate(ip)
  blocked(() => limiter.consumeCreate(ip), 2)
})

test('each operation starts its own window on its first attempt and cleanup respects staggered expirations', t => {
  const { clock, intervals } = setup(t)
  const limiter = createCommentRequestLimiter({ COMMENT_CREATE_MAX: '1', COMMENT_CREATE_WINDOW_SECONDS: '2',
    COMMENT_DELETE_MAX: '1', COMMENT_DELETE_WINDOW_SECONDS: '5' })
  clock.now = 20000
  limiter.consumeCreate(ip)
  clock.now = 20500
  limiter.consumeDelete(ip)
  clock.now = 22000
  for (const entry of intervals) entry.callback()
  limiter.consumeCreate(ip)
  blocked(() => limiter.consumeDelete(ip), 4)
  clock.now = 25499
  blocked(() => limiter.consumeDelete(ip), 1)
  clock.now = 25500
  for (const entry of intervals) entry.callback()
  limiter.consumeDelete(ip)
  blocked(() => limiter.consumeDelete(ip), 5)
})

test('IPv6 client addresses work and invalid internal IP inputs fail without consuming any valid client quota', t => {
  setup(t)
  const limiter = createCommentRequestLimiter({ COMMENT_CREATE_MAX: '1', COMMENT_DELETE_MAX: '1' })
  for (const method of [limiter.consumeCreate, limiter.consumeDelete]) {
    for (const value of [undefined, null, '', ' ', {}, [], 1, 'private-value', ip + ':video-1', ip + ' ', 'unknown']) {
      assert.throws(() => method(value), {
        name: 'TypeError', message: 'Comment request limiting requires a valid client IP.',
      })
    }
    for (const address of [ip, '2001:db8::1', '::ffff:192.0.2.3']) method(address)
  }
  blocked(() => limiter.consumeCreate('2001:db8::1'), 60)
  blocked(() => limiter.consumeDelete('2001:db8::1'), 900)
})

test('independently created application instances do not share memory or expose quota reset methods', t => {
  const { intervals } = setup(t)
  const first = createCommentRequestLimiter({ COMMENT_CREATE_MAX: '1' })
  const second = createCommentRequestLimiter({ COMMENT_CREATE_MAX: '1' })
  first.consumeCreate(ip)
  blocked(() => first.consumeCreate(ip), 60)
  second.consumeCreate(ip)
  blocked(() => second.consumeCreate(ip), 60)
  assert.equal(first.reset, undefined)
  assert.equal(intervals.length, 4)
})

test('a burst consumes quota before later asynchronous work and admits exactly the configured attempt count', async t => {
  setup(t)
  const limiter = createCommentRequestLimiter({ COMMENT_CREATE_MAX: '3' })
  const results = await Promise.all(Array.from({ length: 25 }, async () => {
    try {
      limiter.consumeCreate(ip)
    } catch (error) {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 429)
      return false
    }
    await Promise.resolve()
    return true
  }))
  assert.equal(results.filter(Boolean).length, 3)
  assert.equal(results.filter(value => !value).length, 22)
  blocked(() => limiter.consumeCreate(ip), 60)
})

test('invalid settings fail before either limiter can allocate a timer or partial state', t => {
  const { intervals } = setup(t)
  assert.throws(() => createCommentRequestLimiter({ COMMENT_DELETE_WINDOW_SECONDS: '0' }), TypeError)
  assert.equal(intervals.length, 0)
  const limiter = createCommentRequestLimiter({ COMMENT_CREATE_MAX: '1' })
  limiter.consumeCreate(ip)
  blocked(() => limiter.consumeCreate(ip), 60)
  assert.equal(intervals.length, 2)
})
