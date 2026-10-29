import { toThumbnailUrl, toVideoUrl } from '../utils/media-url.js'

// 영상 1개를 API 응답 모양으로 만드는 공통 도구.
// 영상 상세, 영상 목록, 학습과정 상세가 같은 모양을 써야 해서 한곳에 둔다.
//
// joins, extraColumns, where, orderBy, limitSql은 코드가 직접 쓰는 고정 문장만 넣는다.
// 사용자 입력은 반드시 params로 넘겨 바인딩한다.
// extraColumns로 가져온 값을 응답에 붙이려면 mapExtra(row)가 돌려주는 객체를 영상 항목에 합친다.
export function loadVideos(database, { joins = '', extraColumns = '', where = '', orderBy = 'v.id DESC', limitSql = '', params = [], visitorId = null, mapExtra = () => ({}) } = {}) {
  const rows = database.prepare(`SELECT v.id, v.title, v.description, v.video_path, v.thumbnail_path,
      v.created_at, v.updated_at,
      (SELECT COUNT(*) FROM video_views x WHERE x.video_id = v.id) AS view_count,
      (SELECT COUNT(*) FROM video_likes x WHERE x.video_id = v.id) AS like_count,
      EXISTS (SELECT 1 FROM video_likes x WHERE x.video_id = v.id AND x.visitor_id = ?) AS liked_by_me,
      (SELECT COUNT(*) FROM comments x WHERE x.video_id = v.id) AS comment_count,
      EXISTS (SELECT 1 FROM quizzes x WHERE x.video_id = v.id) AS has_quiz
      ${extraColumns}
    FROM videos v ${joins} ${where} ORDER BY ${orderBy} ${limitSql}`).all(visitorId, ...params)

  const tagsByVideo = loadTags(database, rows.map(row => row.id))
  return rows.map(row => ({ ...toVideoDto(row, tagsByVideo.get(row.id) ?? []), ...mapExtra(row) }))
}

// 영상별 태그를 이름순으로 모은다.
function loadTags(database, videoIds) {
  const tagsByVideo = new Map()
  if (videoIds.length === 0) return tagsByVideo

  const placeholders = videoIds.map(() => '?').join(', ')
  const rows = database.prepare(`SELECT vt.video_id, t.id, t.name FROM video_tags vt
    JOIN tags t ON t.id = vt.tag_id WHERE vt.video_id IN (${placeholders}) ORDER BY t.name, t.id`).all(...videoIds)
  for (const { video_id: videoId, id, name } of rows) {
    if (!tagsByVideo.has(videoId)) tagsByVideo.set(videoId, [])
    tagsByVideo.get(videoId).push({ id, name })
  }
  return tagsByVideo
}

function toVideoDto(row, tags) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    tags,
    videoUrl: toVideoUrl(row.video_path),
    thumbnailUrl: toThumbnailUrl(row.thumbnail_path),
    viewCount: row.view_count,
    likeCount: row.like_count,
    likedByMe: row.liked_by_me === 1,
    commentCount: row.comment_count,
    hasQuiz: row.has_quiz === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
