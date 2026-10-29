import { loadQuiz } from './quiz-queries.js'
import { loadVideos } from './video-queries.js'

// 영상 1개를 관리자 편집 정보(AdminVideo)로 읽는다: Video + tagIds, videoPath, thumbnailPath, quiz. 없으면 null.
// 트랜잭션은 부르는 쪽이 정한다(이 함수 안에서 새 트랜잭션을 열지 않는다).
export function readAdminVideo(database, id) {
  const [found] = loadVideos(database, {
    where: 'WHERE v.id = ?',
    params: [id],
    mapExtra: row => ({ videoPath: row.video_path, thumbnailPath: row.thumbnail_path })
  })
  if (!found) return null

  // 명세서의 필드 순서: Video 필드 다음에 편집용 필드
  const { videoPath, thumbnailPath, ...base } = found
  return {
    ...base,
    tagIds: base.tags.map(tag => tag.id).sort((first, second) => first - second),
    videoPath,
    thumbnailPath,
    quiz: loadQuiz(database, id)
  }
}
