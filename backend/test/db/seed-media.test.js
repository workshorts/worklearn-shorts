import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, ftruncateSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { verifySeedMedia } from '../../src/db/seed-media.js'
import { createDatabaseContext } from '../helpers/database-context.js'

// Signature fixtures test format detection, not decoding or playable sample media.
const formats = {
  mp4: Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex'),
  webm: Buffer.from('1a45dfa3874282847765626d', 'hex'),
  png: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'),
  jpg: Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex'),
  webp: Buffer.from('52494646220000005745425056503820160000003001009d012a0100010001402625a400037000fefd205000', 'hex')
}

function layout(t) {
  const context = createDatabaseContext(t)
  const root = context.path('uploads')
  mkdirSync(join(root, 'videos'), { recursive: true })
  mkdirSync(join(root, 'thumbnails'))
  function file(kind, number, extension, contents = formats[extension === 'jpeg' ? 'jpg' : extension.toLowerCase()]) {
    const name = `40000000-0000-4000-8000-${String(number).padStart(12, '0')}.${extension}`
    const path = `${kind}/${name}`
    writeFileSync(join(root, path), contents)
    return path
  }
  return { context, root, file }
}

function rejectMedia(samples, uploadDir, field) {
  return assert.rejects(verifySeedMedia(samples, { uploadDir }), error => {
    assert.equal(error.code, 'INVALID_SEED_MEDIA')
    if (field) assert.deepEqual(Object.keys(error.fields), [field])
    return true
  })
}

test('seed media detects MP4, WebM, PNG, JPEG and WebP contents and normalizes optional thumbnails', { timeout: 10000 }, async t => {
  const { root, file } = layout(t)
  const samples = [
    { videoPath: file('videos', 1, 'mp4'), thumbnailPath: file('thumbnails', 1, 'png') },
    { videoPath: file('videos', 2, 'webm'), thumbnailPath: file('thumbnails', 2, 'jpg') },
    { videoPath: file('videos', 3, 'mp4'), thumbnailPath: file('thumbnails', 3, 'jpeg') },
    { videoPath: file('videos', 4, 'mp4'), thumbnailPath: file('thumbnails', 4, 'webp') },
    { videoPath: file('videos', 5, 'MP4'), thumbnailPath: null },
    { videoPath: file('videos', 6, 'mp4') }
  ]
  const before = structuredClone(samples)
  const result = await verifySeedMedia(samples, { uploadDir: root })
  assert.deepEqual(samples, before)
  assert.deepEqual(result.map(item => item.video.mime), ['video/mp4', 'video/webm', 'video/mp4', 'video/mp4', 'video/mp4', 'video/mp4'])
  assert.deepEqual(result.map(item => item.thumbnail?.mime ?? null), ['image/png', 'image/jpeg', 'image/jpeg', 'image/webp', null, null])
  for (let index = 0; index < result.length; index += 1) {
    assert.equal(result[index].videoPath, samples[index].videoPath)
    assert.equal(result[index].video.size, readFileSync(join(root, samples[index].videoPath)).length)
  }
})

test('seed media resolves relative upload roots from backend rather than the process directory', async t => {
  const { root, file } = layout(t)
  const backend = fileURLToPath(new URL('../../', import.meta.url))
  const videoPath = file('videos', 1, 'mp4')
  const result = await verifySeedMedia([{ videoPath }], { uploadDir: relative(backend, root) })
  assert.equal(result[0].videoPath, videoPath)
})

test('seed media refuses missing storage without creating files or directories', async t => {
  const context = createDatabaseContext(t)
  const root = context.path('not-ready')
  await rejectMedia([{ videoPath: 'videos/40000000-0000-4000-8000-000000000001.mp4' }], root, 'samples[0].videoPath')
  assert.equal(existsSync(root), false)
  assert.deepEqual(readdirSync(context.directory), [])
})

test('seed media rejects absolute, traversal, URL, backslash and non-UUID paths before reading files', async t => {
  const { root } = layout(t)
  const paths = [
    undefined, null, 1, '', '../video.mp4', '/uploads/videos/a.mp4', 'C:/video.mp4',
    'https://example.invalid/video.mp4', 'videos\\40000000-0000-4000-8000-000000000001.mp4',
    'videos/%2e%2e/video.mp4', 'videos/a.mp4', 'videos/nested/40000000-0000-4000-8000-000000000001.mp4',
    'videos/40000000-0000-4000-8000-000000000001.avi',
    'videos/40000000-0000-4000-8000-000000000001.mp4\n'
  ]
  for (const videoPath of paths) await rejectMedia([{ videoPath }], root, 'samples[0].videoPath')
})

test('seed media rejects invalid manifests, empty sample lists and invalid upload roots', async t => {
  const { root } = layout(t)
  for (const samples of [null, {}, [], [null], [[]], ['video']]) {
    await rejectMedia(samples, root)
  }
  for (const uploadDir of ['', '\0', 7, null]) {
    await rejectMedia([{ videoPath: 'videos/40000000-0000-4000-8000-000000000001.mp4' }], uploadDir, 'UPLOAD_DIR')
  }
})

test('seed media rejects an explicitly empty thumbnail path instead of treating it as absent', async t => {
  const { root, file } = layout(t)
  await rejectMedia([{ videoPath: file('videos', 1, 'mp4'), thumbnailPath: '' }], root, 'samples[0].thumbnailPath')
})

test('seed media rejects a missing required video or a missing supplied thumbnail', async t => {
  const { root, file } = layout(t)
  const missingVideo = 'videos/40000000-0000-4000-8000-000000000009.mp4'
  await rejectMedia([{ videoPath: missingVideo }], root, 'samples[0].videoPath')
  const videoPath = file('videos', 1, 'mp4')
  await rejectMedia([{ videoPath, thumbnailPath: 'thumbnails/40000000-0000-4000-8000-000000000009.png' }], root, 'samples[0].thumbnailPath')
})

test('seed media rejects text disguised as video and mismatched binary image or video types', async t => {
  const { root, file } = layout(t)
  for (const bytes of [Buffer.from('This is not a media file.'), formats.png, formats.webm]) {
    const videoPath = file('videos', 1, 'mp4', bytes)
    await rejectMedia([{ videoPath }], root, 'samples[0].videoPath')
  }
  const videoPath = file('videos', 2, 'mp4')
  const thumbnailPath = file('thumbnails', 2, 'png', formats.jpg)
  await rejectMedia([{ videoPath, thumbnailPath }], root, 'samples[0].thumbnailPath')
})

test('seed media rejects empty and truncated contents for required and optional files', async t => {
  const { root, file } = layout(t)
  for (const bytes of [Buffer.alloc(0), Buffer.from([0, 1, 2])]) {
    await rejectMedia([{ videoPath: file('videos', 1, 'mp4', bytes) }], root, 'samples[0].videoPath')
  }
  const videoPath = file('videos', 2, 'mp4')
  await rejectMedia([{ videoPath, thumbnailPath: file('thumbnails', 2, 'png', Buffer.alloc(0)) }], root, 'samples[0].thumbnailPath')
})

test('seed media accepts exact size limits and rejects one byte over each limit', { timeout: 15000 }, async t => {
  const { root, file } = layout(t)
  const videoPath = file('videos', 1, 'mp4')
  const thumbnailPath = file('thumbnails', 1, 'jpg')
  function resize(path, size) {
    const descriptor = openSync(join(root, path), 'r+')
    try { ftruncateSync(descriptor, size) } finally { closeSync(descriptor) }
  }
  resize(videoPath, 50 * 1024 * 1024)
  resize(thumbnailPath, 10 * 1024 * 1024)
  const result = await verifySeedMedia([{ videoPath, thumbnailPath }], { uploadDir: root })
  assert.equal(result[0].video.size, 50 * 1024 * 1024)
  assert.equal(result[0].thumbnail.size, 10 * 1024 * 1024)
  resize(videoPath, 50 * 1024 * 1024 + 1)
  await rejectMedia([{ videoPath }], root, 'samples[0].videoPath')
  resize(videoPath, formats.mp4.length)
  resize(thumbnailPath, 10 * 1024 * 1024 + 1)
  await rejectMedia([{ videoPath, thumbnailPath }], root, 'samples[0].thumbnailPath')
})

test('seed media rejects directories masquerading as media files', async t => {
  const { root } = layout(t)
  const videoPath = 'videos/40000000-0000-4000-8000-000000000001.mp4'
  mkdirSync(join(root, videoPath))
  await rejectMedia([{ videoPath }], root, 'samples[0].videoPath')
})

for (const kind of ['root', 'videos']) {
  test(`seed media rejects a linked ${kind} directory without reading outside storage`, async t => {
    const context = createDatabaseContext(t)
    const root = context.path('uploads')
    const outside = context.path('outside')
    mkdirSync(outside)
    const videoPath = 'videos/40000000-0000-4000-8000-000000000001.mp4'
    let link
    if (kind === 'root') {
      mkdirSync(join(outside, 'videos'))
      writeFileSync(join(outside, videoPath), formats.mp4)
      link = root
    } else {
      mkdirSync(root)
      writeFileSync(join(outside, videoPath.slice('videos/'.length)), formats.mp4)
      link = join(root, 'videos')
    }
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    context.addCleanup(() => unlinkSync(link))
    await rejectMedia([{ videoPath }], root, 'samples[0].videoPath')
  })
}

test('seed media rejects hard-linked files', async t => {
  const { context, root } = layout(t)
  const target = context.path('outside.mp4')
  writeFileSync(target, formats.mp4)
  const videoPath = 'videos/40000000-0000-4000-8000-000000000001.mp4'
  linkSync(target, join(root, videoPath))
  await rejectMedia([{ videoPath }], root, 'samples[0].videoPath')
})

test('seed media rejects shared video and thumbnail paths in the manifest', async t => {
  const { root, file } = layout(t)
  const videoPath = file('videos', 1, 'mp4')
  await rejectMedia([{ videoPath }, { videoPath }], root, 'samples[1].videoPath')
  const second = file('videos', 2, 'mp4')
  const thumbnailPath = file('thumbnails', 1, 'png')
  await rejectMedia([{ videoPath, thumbnailPath }, { videoPath: second, thumbnailPath }], root, 'samples[1].thumbnailPath')
})

test('seed media preserves files on success and later failure and closes file descriptors', async t => {
  const { context, root, file } = layout(t)
  const videoPath = file('videos', 1, 'mp4')
  const path = join(root, videoPath)
  const hash = () => createHash('sha256').update(readFileSync(path)).digest('hex')
  const before = hash()
  await verifySeedMedia([{ videoPath }], { uploadDir: root })
  const bad = file('videos', 2, 'mp4', Buffer.from('not media'))
  await rejectMedia([{ videoPath }, { videoPath: bad }], root, 'samples[1].videoPath')
  assert.equal(hash(), before)
  for (const candidate of [videoPath, bad]) {
    const original = join(root, candidate)
    const moved = context.path('closed-media.tmp')
    renameSync(original, moved)
    renameSync(moved, original)
  }
})

test('seed media errors omit internal paths and raw filesystem diagnostics', async t => {
  const context = createDatabaseContext(t)
  const root = context.path('private-storage-sentinel')
  await assert.rejects(verifySeedMedia([{ videoPath: 'videos/40000000-0000-4000-8000-000000000001.mp4' }], { uploadDir: root }), error => {
    for (const output of [String(error), JSON.stringify(error), inspect(error)]) {
      assert.equal(output.includes(root), false)
      assert.equal(output.includes('private-storage-sentinel'), false)
      assert.equal(output.includes('ENOENT'), false)
    }
    assert.equal(error.cause, undefined)
    return true
  })
})
