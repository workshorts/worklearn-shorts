// Build an explicit public object so private DB columns and serialization hooks stay internal.
export function toCommentDto(row) {
  return {
    id: row.id,
    videoId: row.video_id,
    nickname: row.nickname,
    content: row.content,
    createdAt: row.created_at,
  }
}
