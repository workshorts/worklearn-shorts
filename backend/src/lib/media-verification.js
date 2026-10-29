import { config } from '../config/index.js'
import { verifySeedMedia } from '../db/seed-media.js'
import { errors } from '../errors.js'

// 영상 등록 요청의 파일이 실제로 있고, 올바른 형식·크기인지 확인한다. 시드와 같은 검사(내용 시그니처, 일반 파일,
// 업로드 폴더 안, 링크 아님)를 쓰므로 업로드 API가 만든 파일은 통과한다. 부르는 쪽이 경로 형식을 먼저 확인해야 한다.
export async function verifyMediaFiles({ videoPath, thumbnailPath }) {
  try {
    await verifySeedMedia([{ videoPath, thumbnailPath }], { uploadDir: config.uploadDir })
  } catch (error) {
    if (error?.code !== 'INVALID_SEED_MEDIA') throw error

    // 시드용 영어 메시지·내부 경로는 노출하지 않고, 어느 파일이 문제인지만 알려 준다.
    const fields = Object.create(null)
    for (const key of Object.keys(error.fields ?? {})) {
      if (key.endsWith('.thumbnailPath')) fields.thumbnailPath = '업로드한 썸네일 파일을 찾을 수 없거나 올바른 PNG·JPEG·WebP 파일이 아닙니다.'
      else fields.videoPath = '업로드한 영상 파일을 찾을 수 없거나 올바른 MP4·WebM 파일이 아닙니다.'
    }
    throw errors.validation(fields)
  }
}
