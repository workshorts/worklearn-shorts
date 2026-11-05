import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { validateCommentListRequest } from '../../src/middleware/validateCommentListRequest.js'
import { startAuthServer } from '../helpers/auth-server.js'

const fields = {
  id: 'ID는 1 이상 9007199254740991 이하의 정수로 입력하세요.',
  page: '페이지는 1 이상 9007199254740991 이하의 정수로 입력하세요.',
  limit: '페이지당 항목 수는 1 이상 50 이하의 정수로 입력하세요.',
}
const invalid = ['', '0', '-1', '+1', '1.5', '1e2', '0x10', ' 1', '1 ', '1\n', '１', 'private-value',
  '9007199254740992', '9'.repeat(400), null, 1, true, ['1'], ['1', '1'], {}]
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function input(id, query = {}) {
  return Object.freeze({ params: Object.freeze({ id }), query: Object.freeze(query) })
}

function accepts(req, expected) {
  const res = { locals: { existing: 'preserved' } }
  let calls = 0
  validateCommentListRequest(req, res, () => { calls += 1 })
  assert.equal(calls, 1)
  assert.deepEqual(res.locals, { existing: 'preserved', commentListRequest: expected })
}

function rejects(req, field) {
  const res = { locals: { existing: 'preserved' } }
  assert.throws(() => validateCommentListRequest(req, res,
    () => assert.fail('Rejected input must stop before the continuation')), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 400)
    assert.equal(error.code, 'VALIDATION_ERROR')
    assert.equal(error.message, '입력값을 확인하세요.')
    assert.deepEqual(error.fields, { [field]: fields[field] })
    return true
  })
  assert.deepEqual(res.locals, { existing: 'preserved' })
}

test('comment list input reuses defaults, leading-zero normalization and all valid page-size boundaries', () => {
  accepts(input('0007'), { id: 7, page: 1, limit: 20 })
  accepts(input('9007199254740991', { page: '9007199254740991', limit: '1' }),
    { id: Number.MAX_SAFE_INTEGER, page: Number.MAX_SAFE_INTEGER, limit: 1 })
  accepts(input('1', { page: '0002' }), { id: 1, page: 2, limit: 20 })
  for (let limit = 1; limit <= 50; limit++) {
    accepts(input('1', { limit: '00' + limit }), { id: 1, page: 1, limit })
  }
})

test('invalid comment parent IDs stop without publishing a partially validated request', () => {
  for (const id of [undefined, ...invalid]) rejects(input(id), 'id')
})

test('invalid pagination and later fields retain the existing context and validation order', () => {
  for (const page of invalid) rejects(input('1', { page }), 'page')
  for (const limit of [...invalid, '51', '9007199254740991']) rejects(input('1', { page: '2', limit }), 'limit')
  rejects(input('0', { page: '0', limit: '0' }), 'id')
  rejects(input('1', { page: '0', limit: '0' }), 'page')
})

test('public comment input does not read visitor headers or validate unrelated list filters', () => {
  const req = input('0007', { page: '0002', limit: '050', tagId: 'invalid', visitorId: 'invalid' })
  // Headers and authentication are absent; only the declared ID and pagination are required.
  accepts(req, { id: 7, page: 2, limit: 50 })
})

test('the registered public comment path rejects invalid real HTTP input before any database work', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const id = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Comment parent video', 'videos/10000000-0000-4000-8000-000000000001.mp4').lastInsertRowid
  function snapshot() {
    return {
      rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
      schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
      hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
    }
  }
  const before = snapshot()
  async function noSql(subtest, paths, field) {
    const prepare = database.prepare.bind(database)
    const exec = database.exec.bind(database)
    const prepared = subtest.mock.method(database, 'prepare', (...args) => prepare(...args))
    const executed = subtest.mock.method(database, 'exec', (...args) => exec(...args))
    try {
      for (const path of paths) {
        const response = await request(path)
        assert.equal(response.status, 400, path)
        assert.deepEqual(response.json, { code: 'VALIDATION_ERROR', message: '입력값을 확인하세요.', fields: { [field]: fields[field] } })
        assert.equal(response.headers['set-cookie'], undefined)
        assert.match(response.headers['content-type'], /^application\/json\b/)
      }
      assert.equal(prepared.mock.callCount(), 0)
      assert.equal(executed.mock.callCount(), 0)
    } finally {
      prepared.mock.restore()
      executed.mock.restore()
    }
    assert.deepEqual(snapshot(), before)
    assert.equal(database.isTransaction, false)
  }

  await t.test('invalid path IDs produce fields.id without a parent lookup', async subtest => {
    const ids = ['0', '-1', '+1', '1.5', '1e2', '0x10', 'abc', '１', ' 1', '1 ', '9007199254740992', '9'.repeat(400)]
    await noSql(subtest, ids.map(value => '/api/videos/' + encodeURIComponent(value) + '/comments'), 'id')
  })
  await t.test('blank, malformed and repeated pages are rejected for existing and absent valid video IDs', async subtest => {
    const queries = ['page', 'page=', 'page=0', 'page=-1', 'page=1.5', 'page=abc', 'page=1e2',
      'page=9007199254740992', 'page=1&page=1', 'page=1&page=2', 'page=%20', 'page=%EF%BC%91']
    await noSql(subtest, [id, Number.MAX_SAFE_INTEGER].flatMap(videoId =>
      queries.map(query => `/api/videos/${videoId}/comments?${query}`)), 'page')
  })
  await t.test('blank, malformed, excessive and repeated limits fail before SQL or a transaction', async subtest => {
    const queries = ['limit', 'limit=', 'limit=0', 'limit=-1', 'limit=1.5', 'limit=abc', 'limit=1e2',
      'limit=51', 'limit=9007199254740991', 'limit=20&limit=20', 'limit=20&limit=50', 'limit=%20', 'limit=%EF%BC%91']
    await noSql(subtest, [id, Number.MAX_SAFE_INTEGER].flatMap(videoId =>
      queries.map(query => `/api/videos/${videoId}/comments?page=2&${query}`)), 'limit')
  })
  assert.deepEqual(snapshot(), before)
})
