import { lstatSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { withTransaction } from '../db/transaction.js'
import { THUMBNAIL_PATH, VIDEO_PATH } from './video-input.js'

// 미등록 업로드 파일 정리. 업로드 API로 올리기만 하고 영상 등록·수정에 쓰이지 않은 파일은 영원히 남기 때문에 따로 정리한다.
// 안전 원칙: (1) 업로드 API가 만든 이름 규칙(videos/UUID.ext, thumbnails/UUID.ext)의 '일반 파일'만 대상이다.
// (2) DB의 어떤 영상도 쓰지 않고 (3) 마지막 수정이 minAge보다 오래된 파일만 지운다(방금 올려 아직 등록 중인 파일 보호).
// (4) 지우는 순간 다시 한 번, 쓰기 잠금을 잡은 채로 확인한다(그 사이 등록된 파일 보호).
export const MIN_AGE_HOURS = 1
export const DEFAULT_AGE_HOURS = 24
const FOLDERS = [['videos', VIDEO_PATH], ['thumbnails', THUMBNAIL_PATH]]
const matches = (pattern, value) => pattern.exec(value)?.[0] === value

// 영상이 쓰는 파일 경로 집합(소문자). 대소문자만 다른 이름도 같은 파일로 본다(등록 API와 같은 기준).
function loadUsedPaths(database) {
  const used = new Set()
  for (const row of database.prepare('SELECT video_path, thumbnail_path FROM videos').all()) {
    used.add(row.video_path.toLowerCase())
    if (row.thumbnail_path !== null) used.add(row.thumbnail_path.toLowerCase())
  }
  return used
}

// 업로드 폴더를 훑어 분류만 한다(아무것도 지우지 않는다).
// 반환: { used 쓰이는 파일 수, tooNew 최근 파일이라 보류한 수, skipped 건드리지 않은 항목, candidates 정리 대상 }
export function scanUploads(database, uploadDir, { minAgeMs, now = Date.now() }) {
  const used = loadUsedPaths(database)
  const report = { used: 0, tooNew: 0, skipped: [], candidates: [] }

  for (const [folder, pattern] of FOLDERS) {
    let names
    try {
      names = readdirSync(join(uploadDir, folder))
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }

    for (const name of names.sort()) {
      const path = `${folder}/${name}`
      let stat
      try {
        stat = lstatSync(join(uploadDir, path))
      } catch (error) {
        if (error?.code === 'ENOENT') continue // 훑는 사이에 사라진 파일
        throw error
      }

      if (!stat.isFile()) report.skipped.push({ path, reason: '일반 파일이 아님(링크·폴더)' })
      else if (!matches(pattern, path)) report.skipped.push({ path, reason: '업로드 API가 만든 이름이 아님' })
      else if (used.has(path.toLowerCase())) report.used += 1
      else if (now - stat.mtimeMs < minAgeMs) report.tooNew += 1
      else report.candidates.push({ path, size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
  return report
}

// 정리 대상을 실제로 지운다. 쓰기 잠금(IMMEDIATE)을 잡고 한 번 더 확인하므로, 훑은 뒤에 영상 등록에 쓰이기 시작한 파일,
// 다시 수정된 파일, 이미 사라진 파일은 지우지 않는다. 등록·수정 요청은 이 잠금이 풀릴 때까지 잠깐 기다린다.
export function deleteUploads(database, uploadDir, candidates) {
  return withTransaction(database, connection => {
    const used = loadUsedPaths(connection)
    const result = { deleted: [], skipped: [], failed: [], freedBytes: 0 }

    for (const candidate of candidates) {
      if (used.has(candidate.path.toLowerCase())) {
        result.skipped.push({ path: candidate.path, reason: '그 사이 영상에 연결됨' })
        continue
      }

      const target = join(uploadDir, candidate.path)
      let stat
      try {
        stat = lstatSync(target)
      } catch (error) {
        if (error?.code === 'ENOENT') result.skipped.push({ path: candidate.path, reason: '이미 사라짐' })
        else result.failed.push({ path: candidate.path, code: error?.code ?? 'UNKNOWN' })
        continue
      }
      if (!stat.isFile() || stat.mtimeMs !== candidate.mtimeMs || stat.size !== candidate.size) {
        result.skipped.push({ path: candidate.path, reason: '훑은 뒤에 파일이 바뀜' })
        continue
      }

      try {
        unlinkSync(target)
        result.deleted.push(candidate.path)
        result.freedBytes += stat.size
      } catch (error) {
        result.failed.push({ path: candidate.path, code: error?.code ?? 'UNKNOWN' })
      }
    }
    return result
  }, { mode: 'IMMEDIATE' })
}

// 훑기 → (apply일 때만) 삭제. apply가 false면 미리보기라서 아무것도 지우지 않는다.
export function cleanupOrphanUploads(database, uploadDir, { apply = false, minAgeMs = DEFAULT_AGE_HOURS * 3600 * 1000, now = Date.now() } = {}) {
  const scan = scanUploads(database, uploadDir, { minAgeMs, now })
  return { scan, applied: apply ? deleteUploads(database, uploadDir, scan.candidates) : null }
}
