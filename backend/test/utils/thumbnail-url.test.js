import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../src/errors.js'
import { withTransaction } from '../../src/db/transaction.js'
import { SEED_VIDEOS } from '../../src/db/seed-videos.js'
import { errorHandler } from '../../src/middleware/errorHandler.js'
import { toThumbnailUrl, toVideoUrl } from '../../src/utils/media-url.js'
import { createDatabaseContext } from '../helpers/database-context.js'

const uuid = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const thumbnailPath = `thumbnails/${uuid}.png`
const defaultUrl = '/images/default-thumbnail.svg'

function assertInvalid(value) {
  assert.throws(() => toThumbnailUrl(value), error => {
    assert.ok(error instanceof Error)
    assert.equal(error instanceof ApiError, false)
    assert.equal(error.message, 'Invalid stored thumbnail path.')
    assert.equal(error.cause, undefined)
    assert.equal(error.status, undefined)
    assert.equal(error.fields, undefined)
    return true
  })
}

test('thumbnail URL mapping returns the browser-root default only for an explicit null', () => {
  assert.equal(toThumbnailUrl(null), defaultUrl)
  assert.equal(toThumbnailUrl(null), defaultUrl)
  const url = new URL(toThumbnailUrl(null), 'https://example.test/api/videos/1')
  assert.equal(url.origin, 'https://example.test')
  assert.equal(url.pathname, defaultUrl)
  assert.equal(url.search, '')
  assert.equal(url.hash, '')
  assertInvalid(undefined)
  assertInvalid('')
  assert.throws(() => toVideoUrl(null), { message: 'Invalid stored video path.' })
})

test('thumbnail URL mapping supports every permitted extension and preserves stored case and file UUID shapes', () => {
  const names = [uuid, uuid.toUpperCase(), '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff', 'aabbccdd-eeff-9abc-0def-012345abcdef']
  for (const name of names) {
    for (const extension of ['png', 'jpg', 'jpeg', 'webp', 'PNG', 'JpEg', 'WeBp']) {
      const value = `thumbnails/${name}.${extension}`
      const result = toThumbnailUrl(value)
      assert.equal(result, '/uploads/' + value)
      const url = new URL(result, 'https://example.test/api/videos/1')
      assert.equal(url.origin, 'https://example.test')
      assert.equal(url.pathname, '/uploads/' + value)
      assert.equal(url.search, '')
      assert.equal(url.hash, '')
    }
  }
  const mixed = `ThUmBnAiLs/${uuid.toUpperCase()}.PnG`
  assert.equal(toThumbnailUrl(mixed), '/uploads/' + mixed)
})

test('thumbnail URL mapping rejects missing and non-string values instead of applying the default or coercing', () => {
  let conversions = 0
  const object = {
    [Symbol.toPrimitive]() { conversions += 1; return thumbnailPath },
    toString() { conversions += 1; return thumbnailPath },
  }
  for (const value of [undefined, 0, 1, false, true, 1n, Symbol('thumbnail-path'), [],
    [thumbnailPath], {}, object, new String(thumbnailPath), Buffer.from(thumbnailPath),
    new URL('https://example.test/' + thumbnailPath)]) {
    assertInvalid(value)
  }
  assert.equal(conversions, 0)
})

test('thumbnail URL mapping rejects absolute and external locations, traversal and wrong media directories', () => {
  for (const value of [`/${thumbnailPath}`, `/uploads/${thumbnailPath}`, `uploads/${thumbnailPath}`,
    `C:/${thumbnailPath}`, `C:\\private\\${thumbnailPath}`, `\\\\server\\${thumbnailPath}`,
    `/var/private/${thumbnailPath}`, `https://example.test/${thumbnailPath}`, `//example.test/${thumbnailPath}`,
    `file:///${thumbnailPath}`, 'data:image/png;base64,private-data', 'javascript:private-value',
    `blob:https://example.test/${uuid}`, `../${thumbnailPath}`, `./${thumbnailPath}`,
    `thumbnails/../${uuid}.png`, `thumbnails/sub/../${uuid}.png`, `thumbnails//${uuid}.png`,
    `thumbnails\\${uuid}.png`, `videos/${uuid}.png`, `videos/${uuid}.mp4`, `${uuid}.png`, defaultUrl]) {
    assertInvalid(value)
  }
  assert.throws(() => toVideoUrl(thumbnailPath), { message: 'Invalid stored video path.' })
})

test('thumbnail URL mapping rejects whitespace, line terminators, encoded paths, queries and fragments', () => {
  for (const value of ['', ' ', ' ' + thumbnailPath, thumbnailPath + ' ', thumbnailPath + '\t',
    thumbnailPath + '\n', thumbnailPath + '\r', thumbnailPath + '\r\n', thumbnailPath + '\u2028',
    thumbnailPath + '\u2029', thumbnailPath + '\0', '\ufeff' + thumbnailPath,
    thumbnailPath.replace('eeff', 'ee\nff'), thumbnailPath + '?token=private-session',
    thumbnailPath + '#fragment', thumbnailPath + ';private', `thumbnails/%2e%2e/${uuid}.png`,
    `thumbnails%2f${uuid}.png`, `thumbnails/${uuid}%2epng`, thumbnailPath.replace('a', '%61'),
    thumbnailPath + '%00', thumbnailPath + '%0a', thumbnailPath.replace('a', 'ａ'),
    thumbnailPath.replace('0', '٠'), thumbnailPath.replace('-', '−')]) {
    assertInvalid(value)
  }
})

test('thumbnail URL mapping rejects malformed names and unsupported or appended extensions', () => {
  for (const value of ['thumbnails/a.png', `thumbnails/${uuid.replaceAll('-', '')}.png`,
    `thumbnails/${uuid.slice(1)}.png`, `thumbnails/${uuid}0.png`, `thumbnails/{${uuid}}.png`,
    `thumbnails/g${uuid.slice(1)}.png`, `thumbnails/${uuid}`, `thumbnails/${uuid}.`,
    ...['svg', 'gif', 'avif', 'bmp', 'mp4', 'png.exe', 'png/', 'png:stream'].map(extension => `thumbnails/${uuid}.${extension}`)]) {
    assertInvalid(value)
  }
})

test('thumbnail URL mapping supports configured seed thumbnails and nulls without requiring image files', () => {
  assert.ok(SEED_VIDEOS.some(sample => sample.thumbnailPath === null))
  assert.ok(SEED_VIDEOS.some(sample => sample.thumbnailPath !== null))
  for (const sample of SEED_VIDEOS) {
    const before = { ...sample }
    assert.equal(toThumbnailUrl(sample.thumbnailPath), sample.thumbnailPath === null
      ? defaultUrl : '/uploads/' + sample.thumbnailPath)
    assert.deepEqual(sample, before)
  }
})

test('thumbnail URL mapping distinguishes SQLite default nulls from stored invalid values without modifying rows', t => {
  const context = createDatabaseContext(t)
  const database = context.open(context.initialize(context.path('thumbnail-urls.db')).databasePath)
  withTransaction(database, () => {
    database.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
      .run('Default thumbnail', `videos/${uuid}.mp4`)
    const insert = database.prepare('INSERT INTO videos (title, video_path, thumbnail_path) VALUES (?, ?, ?)')
    for (const [title, value] of [['Explicit null', null], ['Stored thumbnail', thumbnailPath],
      ['Blank thumbnail', ''], ['Corrupt thumbnail', 'C:/private/secret.png']]) {
      insert.run(title, `videos/${uuid}.mp4`, value)
    }
  })
  const rows = () => database.prepare('SELECT * FROM videos ORDER BY id').all()
  const before = rows()
  assert.equal(before[0].thumbnail_path, null)
  assert.equal(before[1].thumbnail_path, null)
  assert.equal(toThumbnailUrl(before[0].thumbnail_path), defaultUrl)
  assert.equal(toThumbnailUrl(before[1].thumbnail_path), defaultUrl)
  assert.equal(toThumbnailUrl(before[2].thumbnail_path), '/uploads/' + thumbnailPath)
  assertInvalid(before[3].thumbnail_path)
  assertInvalid(before[4].thumbnail_path)
  assert.deepEqual(rows(), before)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('invalid stored thumbnail paths reach the fixed internal-error response without leaking private input', t => {
  const log = t.mock.method(console, 'error', () => {})
  const values = ['C:/private/private-hash.png', 'https://private.example/secret?token=private-session', '', undefined]
  for (const value of values) {
    let failure
    try { toThumbnailUrl(value) } catch (error) { failure = error }
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
