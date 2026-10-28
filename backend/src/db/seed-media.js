import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileTypeFromBuffer } from 'file-type'
import { config } from '../config/index.js'

const backendDirectory = fileURLToPath(new URL('../../', import.meta.url))
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const rules = {
  video: { directory: 'videos', pattern: new RegExp(`^videos/${uuid}\\.(mp4|webm)$`, 'i'), limit: 50 * 1024 * 1024 },
  thumbnail: { directory: 'thumbnails', pattern: new RegExp(`^thumbnails/${uuid}\\.(png|jpg|jpeg|webp)$`, 'i'), limit: 10 * 1024 * 1024 }
}
const types = {
  mp4: ['mp4', 'video/mp4'], webm: ['webm', 'video/webm'],
  png: ['png', 'image/png'], jpg: ['jpg', 'image/jpeg'],
  jpeg: ['jpg', 'image/jpeg'], webp: ['webp', 'image/webp']
}

function invalid(field, message) {
  const error = new Error('Invalid seed media configuration.')
  error.code = 'INVALID_SEED_MEDIA'
  error.fields = { [field]: message }
  return error
}

function sameIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino
}

function inspectPath(root, kind, relativePath, field) {
  const directory = join(root, rules[kind].directory)
  const path = join(root, relativePath)
  const rootStat = lstatSync(root, { bigint: true })
  const directoryStat = lstatSync(directory, { bigint: true })
  const fileStat = lstatSync(path, { bigint: true })
  const realRoot = realpathSync(root)

  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() ||
      directoryStat.isSymbolicLink() || !directoryStat.isDirectory() ||
      fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.nlink !== 1n || fileStat.ino === 0n ||
      realpathSync(directory) !== join(realRoot, rules[kind].directory) ||
      realpathSync(path) !== join(realRoot, relativePath)) {
    throw invalid(field, 'Must be a regular, unlinked file inside the upload directory.')
  }

  return { path, rootStat, directoryStat, fileStat }
}

async function inspectFile(root, kind, relativePath, field) {
  try {
    const before = inspectPath(root, kind, relativePath, field)
    const limit = rules[kind].limit
    if (before.fileStat.size < 1n || before.fileStat.size > BigInt(limit)) {
      throw invalid(field, kind === 'video' ? 'File size must be between 1 byte and 50 MiB.' : 'File size must be between 1 byte and 10 MiB.')
    }

    const descriptor = openSync(before.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const opened = fstatSync(descriptor, { bigint: true })
      if (!opened.isFile() || !sameIdentity(before.fileStat, opened)) {
        throw invalid(field, 'File changed during media verification.')
      }

      // Bound reads even if a different process grows the file after the size check.
      const bytes = Buffer.alloc(Number(before.fileStat.size) + 1)
      let length = 0
      while (length < bytes.length) {
        const count = readSync(descriptor, bytes, length, bytes.length - length, length)
        if (count === 0) break
        length += count
      }
      if (BigInt(length) !== before.fileStat.size) {
        throw invalid(field, 'File changed during media verification.')
      }

      const detected = await fileTypeFromBuffer(bytes.subarray(0, length))
      const extension = relativePath.slice(relativePath.lastIndexOf('.') + 1).toLowerCase()
      const [expectedExtension, expectedMime] = types[extension]
      if (detected?.ext !== expectedExtension || detected.mime !== expectedMime) {
        throw invalid(field, 'File contents must match an allowed extension and MIME type.')
      }

      const after = inspectPath(root, kind, relativePath, field)
      const current = fstatSync(descriptor, { bigint: true })
      if (!sameIdentity(before.rootStat, after.rootStat) || !sameIdentity(before.directoryStat, after.directoryStat) ||
          !sameIdentity(before.fileStat, after.fileStat) || !sameIdentity(before.fileStat, current) ||
          current.nlink !== 1n || current.size !== before.fileStat.size ||
          current.mtimeNs !== before.fileStat.mtimeNs || current.ctimeNs !== before.fileStat.ctimeNs) {
        throw invalid(field, 'File changed during media verification.')
      }

      return { size: length, mime: detected.mime }
    } finally {
      closeSync(descriptor)
    }
  } catch (error) {
    if (error.code === 'INVALID_SEED_MEDIA') throw error
    // Filesystem and parser errors can contain internal paths or input bytes.
    throw invalid(field, 'File must exist, be readable and contain a supported media format.')
  }
}

// Validate manifest paths without accessing the filesystem or starting detection.
export function validateSeedMediaPaths(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw invalid('samples', 'At least one sample video is required.')
  }
  const usedPaths = new Set()
  return Array.from(samples, (sample, index) => {
    if (sample === null || typeof sample !== 'object' || Array.isArray(sample)) {
      throw invalid(`samples[${index}]`, 'Must be a sample video object.')
    }
    const input = { videoPath: sample.videoPath, thumbnailPath: sample.thumbnailPath ?? null }
    for (const [kind, key] of [['video', 'videoPath'], ['thumbnail', 'thumbnailPath']]) {
      const path = input[key]
      if (kind === 'thumbnail' && path === null) continue
      const field = `samples[${index}].${key}`
      if (typeof path !== 'string' || !rules[kind].pattern.test(path) || path.includes('\n') || path.includes('\r')) {
        throw invalid(field, 'Must be a permitted uploads-relative UUID media path.')
      }
      const canonical = path.toLowerCase()
      if (usedPaths.has(canonical)) {
        throw invalid(field, 'A media path must not be shared by multiple sample videos.')
      }
      usedPaths.add(canonical)
    }
    return input
  })
}

// Run before the synchronous seed transaction; detection does not prove playability.
export async function verifySeedMedia(samples, { uploadDir = config.uploadDir } = {}) {
  if (typeof uploadDir !== 'string' || uploadDir.trim() === '' || uploadDir.includes('\0')) {
    throw invalid('UPLOAD_DIR', 'Must be a non-empty filesystem path.')
  }
  const inputs = validateSeedMediaPaths(samples)

  const root = resolve(backendDirectory, uploadDir)
  const results = []
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index]
    const video = await inspectFile(root, 'video', input.videoPath, `samples[${index}].videoPath`)
    const thumbnail = input.thumbnailPath === null ? null : await inspectFile(root, 'thumbnail', input.thumbnailPath, `samples[${index}].thumbnailPath`)
    results.push({ ...input, video, thumbnail })
  }
  return results
}
