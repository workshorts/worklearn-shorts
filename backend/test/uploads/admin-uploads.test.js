import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { removeStaleIncoming } from '../../src/lib/uploads.js'
import { startAuthServer } from '../helpers/auth-server.js'

// 주의: src/config를 불러오는 모듈(seed-media, app 등)은 여기서 바로 import하지 않는다.
// startAuthServer가 UPLOAD_DIR 같은 환경변수를 정하기 전에 설정이 굳어져서, 실제 uploads 폴더에 파일이 저장된다.

// 시험용 최소 파일: 형식을 알아볼 수 있는 시그니처만 담았다(재생 가능한 영상이 아니다).
const SAMPLES = {
  mp4: Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex'),
  webm: Buffer.from('1a45dfa3874282847765626d', 'hex'),
  png: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'),
  jpg: Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex'),
  webp: Buffer.from('52494646220000005745425056503820160000003001009d012a0100010001402625a400037000fefd205000', 'hex'),
  gif: Buffer.from('474946383961010001000000002c00000000010001000002024401003b', 'hex')
}
const MiB = 1024 * 1024
const PATH_PATTERN = /^(videos|thumbnails)\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(mp4|webm|png|jpg|webp)$/

function multipart(parts) {
  const boundary = `----worklearn${randomUUID().replaceAll('-', '')}`
  const chunks = []
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`
    if (part.filename !== undefined) head += `; filename="${part.filename}"`
    head += '\r\n'
    if (part.type) head += `Content-Type: ${part.type}\r\n`
    chunks.push(Buffer.from(`${head}\r\n`), Buffer.isBuffer(part.data) ? part.data : Buffer.from(String(part.data)), Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

// 시그니처 뒤를 0으로 채워 원하는 크기로 만든다.
const padded = (sample, size) => Buffer.concat([sample, Buffer.alloc(size - sample.length)])
const filePart = (data, { filename = 'sample.bin', type = 'application/octet-stream', name = 'file' } = {}) => ({ name, filename, type, data })

test('관리자 파일 업로드 API', { timeout: 120000 }, async t => {
  const { request, login, uploadDir, port } = await startAuthServer(t, { uploads: true })
  const { cookie } = await login()
  const incoming = join(uploadDir, '.incoming')

  // 안전장치: 서버가 시험용 임시 폴더를 쓰고 있는지 확인한다(실제 backend/uploads를 건드리면 안 된다).
  const { config } = await import('../../src/config/index.js')
  assert.equal(config.uploadDir, uploadDir, '서버의 uploadDir이 시험용 임시 폴더와 다르다')
  const { verifySeedMedia } = await import('../../src/db/seed-media.js')

  const upload = (parts, options = {}) => {
    const { body, contentType } = multipart(parts)
    return request('/api/admin/uploads', { method: 'POST', body, headers: { 'Content-Type': contentType, ...options.headers }, cookie: options.cookie === undefined ? cookie : options.cookie })
  }
  const send = (kind, data, file) => upload([{ name: 'kind', data: kind }, filePart(data, file)])
  const incomingFiles = () => (existsSync(incoming) ? readdirSync(incoming) : [])
  const storedFiles = () => ['videos', 'thumbnails'].flatMap(directory => (existsSync(join(uploadDir, directory)) ? readdirSync(join(uploadDir, directory)) : []))
  // 응답 후 정리는 요청이 닫힌 뒤에 끝나므로 잠깐 기다리며 확인한다.
  async function untilEmpty(read) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (read().length === 0) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.deepEqual(read(), [])
  }

  await t.test('로그인하지 않으면 401이고 파일을 만들지 않는다', async () => {
    const res = await send('video', SAMPLES.mp4, {}).then(() => upload([{ name: 'kind', data: 'video' }, filePart(SAMPLES.mp4)], { cookie: '' }))
    assert.equal(res.status, 401)
    assert.equal(res.json.code, 'AUTH_REQUIRED')
    assert.equal(storedFiles().length, 1, '로그인한 앞선 요청의 파일만 있다')
    await untilEmpty(incomingFiles)
  })

  await t.test('허용되지 않은 Origin은 403', async () => {
    const res = await upload([{ name: 'kind', data: 'video' }, filePart(SAMPLES.mp4)], { headers: { Origin: 'http://evil.example' } })
    assert.equal(res.status, 403)
    assert.equal(res.json.code, 'ORIGIN_FORBIDDEN')
  })

  await t.test('영상(MP4)을 올리면 201과 서버가 만든 경로를 돌려주고 파일을 제공한다', async () => {
    const res = await send('video', SAMPLES.mp4, { filename: 'lesson.mp4', type: 'video/mp4' })
    assert.equal(res.status, 201)
    assert.deepEqual(Object.keys(res.json), ['path', 'url'])
    assert.match(res.json.path, PATH_PATTERN)
    assert.ok(res.json.path.startsWith('videos/') && res.json.path.endsWith('.mp4'))
    assert.equal(res.json.url, `/uploads/${res.json.path}`)
    assert.deepEqual(readFileSync(join(uploadDir, res.json.path)), SAMPLES.mp4)
    await untilEmpty(incomingFiles)

    const served = await request(res.json.url)
    assert.equal(served.status, 200)
    const ranged = await request(res.json.url, { headers: { Range: 'bytes=0-3' } })
    assert.equal(ranged.status, 206)
  })

  await t.test('WebM·PNG·JPEG·WebP도 형식에 맞는 확장자로 저장한다', async () => {
    for (const [kind, extension, directory] of [['video', 'webm', 'videos'], ['thumbnail', 'png', 'thumbnails'], ['thumbnail', 'jpg', 'thumbnails'], ['thumbnail', 'webp', 'thumbnails']]) {
      const res = await send(kind, SAMPLES[extension], { filename: `x.${extension === 'jpg' ? 'jpeg' : extension}` })
      assert.equal(res.status, 201, extension)
      assert.match(res.json.path, PATH_PATTERN)
      assert.ok(res.json.path.startsWith(`${directory}/`) && res.json.path.endsWith(`.${extension}`), res.json.path)
    }
  })

  await t.test('올린 파일은 시드와 같은 미디어 검사를 통과한다(영상 등록 API가 다시 확인할 때 같은 기준)', async () => {
    const video = (await send('video', SAMPLES.webm)).json.path
    const thumbnail = (await send('thumbnail', SAMPLES.png)).json.path
    const [verified] = await verifySeedMedia([{ videoPath: video, thumbnailPath: thumbnail }], { uploadDir })
    assert.equal(verified.video.mime, 'video/webm')
    assert.equal(verified.thumbnail.mime, 'image/png')
  })

  await t.test('파일 이름은 무시하고 서버가 UUID 이름을 만든다(경로 조작 불가)', async () => {
    for (const filename of ['../../evil.mp4', '../evil.mp4', 'a/b/c.mp4', '한글 이름.mp4', '..\\evil.mp4', 'x'.repeat(300) + '.mp4']) {
      const res = await send('video', SAMPLES.mp4, { filename, type: 'video/mp4' })
      assert.equal(res.status, 201, filename)
      assert.match(res.json.path, PATH_PATTERN, filename)
    }
    assert.equal(existsSync(join(uploadDir, '..', 'evil.mp4')), false)
    assert.equal(existsSync(join(uploadDir, '..', '..', 'evil.mp4')), false)
  })

  await t.test('같은 내용을 여러 번, 동시에 올려도 경로가 서로 다르다', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => send('video', SAMPLES.mp4)))
    assert.ok(results.every(res => res.status === 201))
    assert.equal(new Set(results.map(res => res.json.path)).size, 6)
    await untilEmpty(incomingFiles)
  })

  await t.test('확장자·Content-Type이 아니라 실제 내용으로 판단해 415로 거절하고 파일을 남기지 않는다', async () => {
    const before = storedFiles().length
    const cases = [
      ['video', Buffer.from('이것은 영상이 아니라 글자입니다'), { filename: 'fake.mp4', type: 'video/mp4' }],
      ['video', SAMPLES.png, { filename: 'image.mp4', type: 'video/mp4' }],
      ['thumbnail', SAMPLES.mp4, { filename: 'video.png', type: 'image/png' }],
      ['thumbnail', SAMPLES.gif, { filename: 'a.gif', type: 'image/gif' }],
      ['video', Buffer.alloc(0), { filename: 'empty.mp4', type: 'video/mp4' }],
      ['thumbnail', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), { filename: 'a.svg', type: 'image/svg+xml' }]
    ]
    for (const [kind, data, file] of cases) {
      const res = await send(kind, data, file)
      assert.equal(res.status, 415, `${kind} ${file.filename}`)
      assert.equal(res.json.code, 'UNSUPPORTED_MEDIA_TYPE')
    }
    assert.equal(storedFiles().length, before)
    await untilEmpty(incomingFiles)
  })

  await t.test('kind와 file 필드 오류는 400이다', async () => {
    const before = storedFiles().length
    const cases = [
      ['kind 없음', [filePart(SAMPLES.mp4)], 'kind'],
      ['kind 값 오류', [{ name: 'kind', data: 'audio' }, filePart(SAMPLES.mp4)], 'kind'],
      ['kind가 file보다 뒤', [filePart(SAMPLES.mp4), { name: 'kind', data: 'video' }], 'kind'],
      ['file 없음', [{ name: 'kind', data: 'video' }], 'file'],
      ['아무것도 없음', [{ name: 'other', data: 'x' }], 'kind'],
      ['파일 필드 이름 오류', [{ name: 'kind', data: 'video' }, filePart(SAMPLES.mp4, { name: 'upload' })], 'file'],
      ['파일 두 개', [{ name: 'kind', data: 'video' }, filePart(SAMPLES.mp4), filePart(SAMPLES.mp4)], 'file']
    ]
    for (const [label, parts, field] of cases) {
      const res = await upload(parts)
      assert.equal(res.status, 400, label)
      assert.equal(res.json.code, 'VALIDATION_ERROR', label)
      assert.ok(res.json.fields[field], label)
    }
    assert.equal(storedFiles().length, before)
    await untilEmpty(incomingFiles)
  })

  await t.test('크기 제한: 영상 50MB, 썸네일 10MB (딱 한도는 통과, 1바이트 넘으면 413)', async () => {
    const before = storedFiles().length
    assert.equal((await send('video', padded(SAMPLES.mp4, 50 * MiB))).status, 201)
    assert.equal((await send('thumbnail', padded(SAMPLES.png, 10 * MiB))).status, 201)
    assert.equal(storedFiles().length, before + 2)

    const bigVideo = await send('video', padded(SAMPLES.mp4, 50 * MiB + 1))
    assert.equal(bigVideo.status, 413)
    assert.equal(bigVideo.json.code, 'FILE_TOO_LARGE')
    const bigThumbnail = await send('thumbnail', padded(SAMPLES.png, 10 * MiB + 1))
    assert.equal(bigThumbnail.status, 413)
    assert.equal(bigThumbnail.json.code, 'FILE_TOO_LARGE')
    // 썸네일 한도는 영상보다 작아서, 영상 한도 안이어도 썸네일로는 거절된다
    assert.equal((await send('thumbnail', padded(SAMPLES.png, 11 * MiB))).status, 413)

    assert.equal(storedFiles().length, before + 2, '거절된 파일은 저장되지 않는다')
    await untilEmpty(incomingFiles)
  })

  await t.test('멀티파트가 아니거나 형식이 깨진 요청은 거절한다', async () => {
    const json = await request('/api/admin/uploads', { method: 'POST', body: { kind: 'video' }, cookie })
    assert.equal(json.status, 415)
    const text = await request('/api/admin/uploads', { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' }, cookie })
    assert.equal(text.status, 415)
    const noType = await request('/api/admin/uploads', { method: 'POST', cookie })
    assert.equal(noType.status, 415)

    const noBoundary = await request('/api/admin/uploads', { method: 'POST', body: 'x', headers: { 'Content-Type': 'multipart/form-data' }, cookie })
    assert.equal(noBoundary.status, 400)
    assert.equal(noBoundary.json.code, 'VALIDATION_ERROR')

    // 닫는 경계 없이 본문이 끝난 요청
    const { body, contentType } = multipart([{ name: 'kind', data: 'video' }, filePart(SAMPLES.mp4)])
    const truncated = await request('/api/admin/uploads', { method: 'POST', body: body.subarray(0, body.length - 20), headers: { 'Content-Type': contentType }, cookie })
    assert.equal(truncated.status, 400)
    await untilEmpty(incomingFiles)
  })

  await t.test('용량이 큰 요청은 본문을 받기 전에 413으로 끊는다', async () => {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/api/admin/uploads', method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': 200 * MiB, Cookie: cookie }
      }, res => {
        res.resume()
        resolve({ status: res.statusCode, connection: res.headers.connection })
        req.destroy()
      })
      req.on('error', error => (error.code === 'ECONNRESET' ? undefined : reject(error)))
      req.write('--x\r\n')
    })
    assert.equal(response.status, 413)
    assert.equal(response.connection, 'close')
  })

  await t.test('올리는 도중 연결이 끊겨도 임시 파일이 남지 않는다', async () => {
    const before = storedFiles().length
    const { body, contentType } = multipart([{ name: 'kind', data: 'video' }, filePart(padded(SAMPLES.mp4, 5 * MiB))])
    await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/api/admin/uploads', method: 'POST',
        headers: { 'Content-Type': contentType, 'Content-Length': body.length, Cookie: cookie }
      })
      req.on('error', () => resolve())
      req.write(body.subarray(0, 2 * MiB), () => setTimeout(() => req.destroy(), 100))
      setTimeout(() => reject(new Error('연결 끊기 시험이 끝나지 않았다')), 5000).unref()
    })
    await untilEmpty(incomingFiles)
    assert.equal(storedFiles().length, before)
  })

  await t.test('임시 폴더는 /uploads로 노출되지 않는다', async () => {
    mkdirSync(incoming, { recursive: true })
    writeFileSync(join(incoming, 'secret.part'), 'x')
    assert.equal((await request('/uploads/.incoming/secret.part')).status, 404)
    rmSync(join(incoming, 'secret.part'))
  })

  await t.test('저장 위치에 문제가 있으면 내부 경로를 숨긴 500으로 답하고 임시 파일을 지운다', async () => {
    const directory = join(uploadDir, 'videos')
    rmSync(directory, { recursive: true })
    writeFileSync(directory, 'not a directory')
    const original = console.error
    console.error = () => {}
    try {
      const res = await send('video', SAMPLES.mp4)
      assert.equal(res.status, 500)
      assert.deepEqual(res.json, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', fields: {} })
      assert.equal(res.text.includes(uploadDir), false)
    } finally {
      console.error = original
      rmSync(directory)
      mkdirSync(directory)
    }
    await untilEmpty(incomingFiles)
  })
})

test('오래된 업로드 임시 파일 정리', async t => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const root = mkdtempSync(join(tmpdir(), 'incoming-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.equal(await removeStaleIncoming(root), 0, '폴더가 없어도 오류 없이 0')

  const directory = join(root, '.incoming')
  mkdirSync(directory)
  const hoursAgo = hours => new Date(Date.now() - hours * 3600 * 1000)
  for (const [name, age] of [['old.part', 3], ['recent.part', 0.1], ['keep.txt', 5]]) {
    writeFileSync(join(directory, name), 'x')
    utimesSync(join(directory, name), hoursAgo(age), hoursAgo(age))
  }
  assert.equal(await removeStaleIncoming(root), 1)
  assert.deepEqual(readdirSync(directory).sort(), ['keep.txt', 'recent.part'], '오래된 .part만 지운다')
})
