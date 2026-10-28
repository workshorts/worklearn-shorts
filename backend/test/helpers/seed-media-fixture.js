import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SEED_VIDEOS } from '../../src/db/seed-videos.js'

// Test-owned signatures exercise detection and persistence, not playable service media.
const formats = {
  mp4: Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex'),
  webm: Buffer.from('1a45dfa3874282847765626d', 'hex'),
  png: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'),
  jpg: Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex'),
  webp: Buffer.from('52494646220000005745425056503820160000003001009d012a0100010001402625a400037000fefd205000', 'hex')
}

export function createSeedMediaFixture(context) {
  const uploadDir = context.path('seed-uploads')
  mkdirSync(join(uploadDir, 'videos'), { recursive: true })
  mkdirSync(join(uploadDir, 'thumbnails'))
  for (const { videoPath, thumbnailPath } of SEED_VIDEOS) {
    for (const path of [videoPath, thumbnailPath]) {
      if (path !== null) writeFileSync(join(uploadDir, path), formats[path.slice(path.lastIndexOf('.') + 1)])
    }
  }
  return uploadDir
}
