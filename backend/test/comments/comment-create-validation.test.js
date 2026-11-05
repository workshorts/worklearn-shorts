import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { validateCommentCreateRequest } from '../../src/middleware/validateCommentCreateRequest.js'
import { startAuthServer } from '../helpers/auth-server.js'

const messages = {
  nickname: '닉네임은 1~20자로 입력하세요.',
  password: '비밀번호는 4~30자로 입력하세요.',
  content: '내용은 1~500자로 입력하세요.',
}
const valid = { nickname: '학습자', password: '1234', content: '유용해요' }
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

function reject(body, fields, id = '1') {
  const res = { locals: { existing: 'preserved' } }
  assert.throws(() => validateCommentCreateRequest({ params: { id }, body }, res,
    () => assert.fail('Invalid input must stop before the continuation')), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 400)
    assert.equal(error.code, 'VALIDATION_ERROR')
    assert.equal(error.message, '입력값을 확인하세요.')
    assert.deepEqual(error.fields, fields)
    return true
  })
  assert.deepEqual(res.locals, { existing: 'preserved' })
}

test('comment creation accepts inclusive ASCII, Korean and supplementary Unicode boundaries', () => {
  for (const char of ['a', '한', '😀']) {
    for (const [nicknameLength, passwordLength, contentLength] of [[1, 4, 1], [20, 30, 500]]) {
      const body = Object.freeze({ nickname: char.repeat(nicknameLength), password: char.repeat(passwordLength),
        content: char.repeat(contentLength), password_hash: 'ignored-private-hash', videoId: 999, id: 999 })
      const res = { locals: { existing: 'preserved' } }
      let calls = 0
      validateCommentCreateRequest({ params: { id: '0007' }, body }, res, () => { calls += 1 })
      assert.equal(calls, 1)
      assert.deepEqual(res.locals, { existing: 'preserved', commentCreateRequest: {
        id: 7, nickname: body.nickname, password: body.password, content: body.content,
      } })
    }
  }
})

test('comment creation preserves spaces, newlines, combining sequences and exact passwords without mutation', () => {
  for (const body of [
    { nickname: ' 학습자 ', password: ' 12 ', content: ' 첫 줄\n다음 줄 ' },
    { nickname: ' ', password: '    ', content: '\n' },
    { nickname: 'e\u0301', password: 'ée\u0301x', content: '👩‍💻' },
  ]) {
    Object.freeze(body)
    const res = { locals: {} }
    validateCommentCreateRequest({ params: { id: String(Number.MAX_SAFE_INTEGER) }, body }, res, () => {})
    assert.deepEqual(res.locals.commentCreateRequest, { id: Number.MAX_SAFE_INTEGER, ...body })
  }
})

test('comment fields reject missing values, non-strings, invalid Unicode, NUL and out-of-range character counts', () => {
  for (const [field, min, max] of [['nickname', 1, 20], ['password', 4, 30], ['content', 1, 500]]) {
    const invalid = [undefined, null, false, 1234, [], ['1234'], {}, '', 'x'.repeat(min - 1),
      '한'.repeat(max + 1), '😀'.repeat(max + 1), 'ok\0secret', '\ud800abc', 'abc\udfff']
    for (const value of invalid) reject({ ...valid, [field]: value }, { [field]: messages[field] })
    const missing = { ...valid }
    delete missing[field]
    reject(missing, { [field]: messages[field] })
  }
})

test('non-object bodies and inherited fields cannot provide required comment input', () => {
  for (const body of [undefined, null, false, 1234, 'private-password', [], [valid], {}, Object.create(valid)]) {
    reject(body, messages)
  }
  reject({ nickname: '', password: 'bad', content: '' }, messages)
})

test('comment parent ID validation runs before fields and never publishes partial input', () => {
  for (const id of ['0', '-1', '+1', '1.5', '1e2', 'abc', '１', ' 1', '1 ', '9007199254740992']) {
    reject({}, { id: 'ID는 1 이상 9007199254740991 이하의 정수로 입력하세요.' }, id)
  }
})

test('real comment POST field failures return safe 400 responses before SQL and preserve the database', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const db = getDb()
  const id = db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('Comment validation parent', 'unused-path').lastInsertRowid
  const snapshot = () => ({
    rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
  })
  const before = snapshot()
  const prepare = db.prepare.bind(db)
  const exec = db.exec.bind(db)
  const prepared = t.mock.method(db, 'prepare', (...args) => prepare(...args))
  const executed = t.mock.method(db, 'exec', (...args) => exec(...args))
  const log = t.mock.method(console, 'error', () => {})
  try {
    const cases = [{ body: {}, fields: messages }, { body: [], fields: messages },
      { body: undefined, fields: messages },
      ...Object.keys(valid).flatMap(field => [null, 1234, ['private-password'], '',
        '😀'.repeat(field === 'nickname' ? 21 : field === 'password' ? 31 : 501), '\ud800abc', 'a\0private-password']
        .map(value => ({ body: { ...valid, [field]: value }, fields: { [field]: messages[field] } }))),
      { body: { ...valid, password: '123' }, fields: { password: messages.password } }]
    for (const videoId of [id, Number.MAX_SAFE_INTEGER]) {
      for (const { body, fields } of cases) {
        const response = await request(`/api/videos/${videoId}/comments`, {
          method: 'POST', body, headers: { 'Content-Type': 'application/json' },
        })
        assert.equal(response.status, 400)
        assert.deepEqual(response.json, { code: 'VALIDATION_ERROR', message: '입력값을 확인하세요.', fields })
        assert.equal(response.headers['set-cookie'], undefined)
        assert.equal(response.headers['retry-after'], undefined)
        assert.match(response.headers['content-type'], /^application\/json\b/)
      }
    }
    const invalidId = await request('/api/videos/0/comments', { method: 'POST', body: {} })
    assert.equal(invalidId.status, 400)
    assert.deepEqual(invalidId.json.fields, { id: 'ID는 1 이상 9007199254740991 이하의 정수로 입력하세요.' })
    assert.equal(prepared.mock.callCount(), 0)
    assert.equal(executed.mock.callCount(), 0)
    assert.equal(log.mock.callCount(), 0)
  } finally {
    prepared.mock.restore()
    executed.mock.restore()
    log.mock.restore()
  }
  assert.equal(db.isTransaction, false)
  assert.deepEqual(snapshot(), before)
})
