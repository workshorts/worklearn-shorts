import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { withTransaction } from '../../src/db/transaction.js'
import { SEED_VIDEOS } from '../../src/db/seed-videos.js'
import { errorHandler } from '../../src/middleware/errorHandler.js'
import { toVideoUrl } from '../../src/utils/media-url.js'
import { createDatabaseContext } from '../helpers/database-context.js'

const uuid = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const videoPath = `videos/${uuid}.mp4`

function assertInvalid(value) {
  assert.throws(() => toVideoUrl(value), error => {
    assert.ok(error instanceof Error)
    assert.equal(error instanceof ApiError, false)
    assert.equal(error.message, 'Invalid stored video path.')
    assert.equal(error.cause, undefined)
    assert.equal(error.status, undefined)
    assert.equal(error.fields, undefined)
    return true
  })
}

test('video URL mapping returns browser-root uploads URLs and preserves the complete stored path case', () => {
  for (const value of [videoPath, `videos/${uuid}.webm`, `videos/${uuid.toUpperCase()}.MP4`,
    `ViDeOs/${uuid.toUpperCase()}.WeBm`]) {
    const result = toVideoUrl(value)
    assert.equal(result, '/uploads/' + value)
    const url = new URL(result, 'https://example.test/api/videos/1')
    assert.equal(url.origin, 'https://example.test')
    assert.equal(url.pathname, '/uploads/' + value)
    assert.equal(url.search, '')
    assert.equal(url.hash, '')
    assert.equal(toVideoUrl(value), result)
  }
})

test('file UUID shapes do not inherit visitor UUID version or variant restrictions', () => {
  for (const name of ['00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff', 'aabbccdd-eeff-9abc-0def-012345abcdef']) {
    assert.equal(toVideoUrl(`videos/${name}.mp4`), `/uploads/videos/${name}.mp4`)
  }
})

test('video URL mapping rejects absolute paths, external URLs, directory traversal and other media locations', () => {
  for (const value of [`/${videoPath}`, `/uploads/${videoPath}`, `uploads/${videoPath}`,
    `C:/${videoPath}`, `C:\\uploads\\${videoPath}`, `\\\\server\\${videoPath}`, `/var/private/${videoPath}`,
    `https://example.test/${videoPath}`, `//example.test/${videoPath}`, `file:///${videoPath}`,
    `data:video/mp4,${uuid}`, `blob:https://example.test/${uuid}`, `javascript:${uuid}`,
    `../${videoPath}`, `./${videoPath}`, `videos/../${uuid}.mp4`, `videos/sub/../${uuid}.mp4`,
    `videos//${uuid}.mp4`, `videos\\${uuid}.mp4`, `thumbnails/${uuid}.mp4`, `${uuid}.mp4`]) {
    assertInvalid(value)
  }
})

test('video URL mapping rejects whitespace, line terminators, query strings, fragments and encoded path alterations', () => {
  for (const value of ['', ' ', ' ' + videoPath, videoPath + ' ', videoPath + '\t',
    videoPath + '\n', videoPath + '\r', videoPath + '\r\n', videoPath + '\u2028', videoPath + '\u2029',
    videoPath + '\0', '\ufeff' + videoPath, videoPath.replace('eeff', 'ee\nff'),
    videoPath + '?token=private-session', videoPath + '#fragment', videoPath + ';private',
    `videos/%2e%2e/${uuid}.mp4`, `videos%2f${uuid}.mp4`, `videos/${uuid}%2emp4`,
    videoPath.replace('a', '%61'), videoPath + '%00', videoPath + '%0a',
    videoPath.replace('a', 'ａ'), videoPath.replace('0', '٠'), videoPath.replace('-', '−')]) {
    assertInvalid(value)
  }
})

test('video URL mapping rejects malformed UUID names and unsupported or appended extensions', () => {
  for (const value of ['videos/a.mp4', `videos/${uuid.replaceAll('-', '')}.mp4`,
    `videos/${uuid.slice(1)}.mp4`, `videos/${uuid}0.mp4`, `videos/{${uuid}}.mp4`,
    `videos/g${uuid.slice(1)}.mp4`, `videos/${uuid}`, `videos/${uuid}.`,
    `videos/${uuid}.mov`, `videos/${uuid}.mkv`, `videos/${uuid}.png`, `videos/${uuid}.mp3`,
    `videos/${uuid}.mp4.exe`, `videos/${uuid}.webm/`, `videos/${uuid}.mp4:stream`]) {
    assertInvalid(value)
  }
})

test('video URL mapping rejects missing and non-string paths without invoking coercion hooks', () => {
  let conversions = 0
  const object = {
    [Symbol.toPrimitive]() { conversions += 1; return videoPath },
    toString() { conversions += 1; return videoPath },
  }
  for (const value of [undefined, null, 1, false, 1n, Symbol('video-path'), [], [videoPath],
    {}, object, new String(videoPath), Buffer.from(videoPath), new URL('https://example.test/' + videoPath)]) {
    assertInvalid(value)
  }
  assert.equal(conversions, 0)
})

test('video URL mapping supports every configured seed path without requiring media files', () => {
  assert.equal(SEED_VIDEOS.length, 8)
  for (const sample of SEED_VIDEOS) {
    const before = { ...sample }
    assert.equal(toVideoUrl(sample.videoPath), '/uploads/' + sample.videoPath)
    assert.deepEqual(sample, before)
  }
})

test('video URL mapping reads stored SQLite paths without changing rows or timestamps and refuses corrupt values', t => {
  const context = createDatabaseContext(t)
  const database = context.open(context.initialize(context.path('video-urls.db')).databasePath)
  withTransaction(database, () => {
    const insert = database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    insert.run('Stored video', videoPath)
    insert.run('Corrupt video', 'C:/private/uploads/secret.mp4')
  })
  const rows = () => database.prepare('SELECT * FROM videos ORDER BY id').all()
  const before = rows()
  assert.equal(toVideoUrl(before[0].video_path), '/uploads/' + videoPath)
  assertInvalid(before[1].video_path)
  assert.deepEqual(rows(), before)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('invalid stored video paths produce a fixed internal response and log without disclosing the supplied path', t => {
  const log = t.mock.method(console, 'error', () => {})
  const values = ['C:/private/uploads/private-hash.mp4', 'https://private.example/secret?token=private-session']
  for (const value of values) {
    let failure
    try { toVideoUrl(value) } catch (error) { failure = error }
    assert.ok(failure instanceof Error)
    const response = {
      headersSent: false,
      status(value) { this.statusCode = value; return this },
      json(value) { this.body = value; return this },
    }
    errorHandler(failure, {}, response, () => assert.fail('Must not forward a handled error'))
    assert.equal(response.statusCode, 500)
    assert.deepEqual(response.body, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
  }
  assert.equal(log.mock.callCount(), values.length)
  for (const call of log.mock.calls) assert.deepEqual(call.arguments, ['INTERNAL_ERROR'])
})
