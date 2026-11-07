import { ApiError } from '../errors.js'
import { normalizeTagName } from '../utils/tag-name.js'

const duplicate = () => new ApiError(409, 'TAG_ALREADY_EXISTS', '이미 있는 태그입니다.', { name: '이미 있는 태그입니다.' })

// 태그를 만들고 { id, name }을 돌려준다. 반드시 쓰기 트랜잭션(IMMEDIATE) 안에서 부른다.
// 같은 이름(앞뒤 공백·대소문자만 다른 것 포함)이 이미 있으면 409다. DB의 유일 인덱스가 마지막 방어선이다.
export function createTag(database, name) {
  if (!database.isTransaction) throw new Error('Tag creation requires an active transaction.')

  if (database.prepare('SELECT 1 FROM tags WHERE normalize_tag_name(name) = ? LIMIT 1').get(normalizeTagName(name))) throw duplicate()

  try {
    return database.prepare('INSERT INTO tags (name) VALUES (?) RETURNING id, name').get(name)
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error?.message))) throw duplicate()
    throw error
  }
}

// 태그를 지운다. 모든 영상의 해당 태그 연결만 연쇄 삭제되고, 영상과 다른 태그는 그대로다. 지웠으면 true, 없었으면 false.
export function deleteTag(database, id) {
  if (!database.isTransaction) throw new Error('Tag deletion requires an active transaction.')
  return database.prepare('DELETE FROM tags WHERE id = ?').run(id).changes > 0
}
