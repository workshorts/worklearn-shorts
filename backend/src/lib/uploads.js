import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileTypeFromFile } from 'file-type'

// 업로드 규칙. 시드(db/seed-media.js)와 같은 기준이다: 영상 50MiB·MP4/WebM, 썸네일 10MiB·PNG/JPEG/WebP.
// 영상 등록 API가 파일을 다시 확인할 때도 같은 규칙을 쓰므로, 여기 값을 바꾸면 그쪽도 같이 바꿔야 한다.
export const UPLOAD_RULES = Object.freeze({
  video: Object.freeze({
    directory: 'videos',
    limit: 50 * 1024 * 1024,
    types: Object.freeze({ 'video/mp4': 'mp4', 'video/webm': 'webm' })
  }),
  thumbnail: Object.freeze({
    directory: 'thumbnails',
    limit: 10 * 1024 * 1024,
    types: Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })
  })
})

// 받는 중인 파일은 여기에 두고, 확인이 끝난 것만 videos·thumbnails로 옮긴다.
// 이름이 .으로 시작해서 /uploads 정적 제공에서 보이지 않는다.
export const INCOMING_DIRECTORY = '.incoming'

export const isUploadKind = value => typeof value === 'string' && Object.hasOwn(UPLOAD_RULES, value)

export async function ensureUploadDirectories(uploadDir) {
  await mkdir(join(uploadDir, INCOMING_DIRECTORY), { recursive: true })
  for (const { directory } of Object.values(UPLOAD_RULES)) {
    await mkdir(join(uploadDir, directory), { recursive: true })
  }
}

export function createIncomingPath(uploadDir) {
  return join(uploadDir, INCOMING_DIRECTORY, `${randomUUID()}.part`)
}

// 파일 내용을 읽어 실제 형식을 확인한다. 확장자나 브라우저가 보낸 형식은 믿지 않는다.
// 종류에 맞는 형식이면 확장자(mp4, webm, png, jpg, webp)를, 아니면 null을 돌려준다.
export async function detectExtension(path, kind) {
  const detected = await fileTypeFromFile(path)
  return detected ? UPLOAD_RULES[kind].types[detected.mime] ?? null : null
}

// 확인이 끝난 임시 파일을 서버가 만든 UUID 이름으로 옮기고, 응답에 쓸 상대 경로를 돌려준다.
export async function publishUpload(uploadDir, incomingPath, kind, extension) {
  const relativePath = `${UPLOAD_RULES[kind].directory}/${randomUUID()}.${extension}`
  await rename(incomingPath, join(uploadDir, relativePath))
  return relativePath
}

// 서버가 갑자기 꺼져서 남은 임시 파일을 지운다. 서버를 켤 때 한 번 부른다.
export async function removeStaleIncoming(uploadDir, { maxAgeMs = 60 * 60 * 1000, now = Date.now() } = {}) {
  const directory = join(uploadDir, INCOMING_DIRECTORY)
  let names
  try {
    names = await readdir(directory)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.part')) continue
    try {
      const { mtimeMs } = await stat(join(directory, name))
      if (now - mtimeMs >= maxAgeMs) {
        await rm(join(directory, name), { force: true })
        removed += 1
      }
    } catch {
      // 다른 곳에서 이미 지웠으면 넘어간다.
    }
  }
  return removed
}
