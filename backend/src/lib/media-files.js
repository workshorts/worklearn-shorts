import { lstat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../config/index.js'
import { THUMBNAIL_PATH, VIDEO_PATH } from './video-input.js'

const isMediaPath = path => typeof path === 'string' &&
  (VIDEO_PATH.exec(path)?.[0] === path || THUMBNAIL_PATH.exec(path)?.[0] === path)

// 영상·썸네일 파일을 지운다. DB 변경이 성공한 뒤에 부르고, 실패해도 요청을 실패시키지 않는다(최선을 다한다).
// 업로드 API가 만든 경로 형식(videos/UUID.ext, thumbnails/UUID.ext)이고 업로드 폴더 안의 '일반 파일'일 때만 지운다.
// 링크나 폴더는 건드리지 않고, 이미 없는 파일은 넘어간다. 지운 개수를 돌려준다.
export async function removeUploadedFiles(paths, uploadDir = config.uploadDir) {
  let removed = 0
  for (const path of paths) {
    if (!isMediaPath(path)) continue
    try {
      const target = join(uploadDir, path)
      if (!(await lstat(target)).isFile()) continue
      await unlink(target)
      removed += 1
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error('Uploaded file cleanup failed.', error?.code ?? 'UNKNOWN')
    }
  }
  return removed
}
