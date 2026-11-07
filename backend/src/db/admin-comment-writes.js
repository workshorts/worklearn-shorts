// 관리자가 댓글을 지운다. 작성자 비밀번호를 확인하지 않고 id로 바로 지운다(사용자 삭제는 services/comment-delete.js).
// 반드시 쓰기 트랜잭션(IMMEDIATE) 안에서 부른다. 지웠으면 true, 없었으면 false.
export function deleteCommentAsAdmin(database, id) {
  if (!database.isTransaction) throw new Error('Admin comment deletion requires an active transaction.')
  return database.prepare('DELETE FROM comments WHERE id = ?').run(id).changes > 0
}
