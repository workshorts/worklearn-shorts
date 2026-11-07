import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { startAuthServer } from '../../backend/test/helpers/auth-server.js';
import { adminRequest } from '../src/api/adminApi.js';

// videoApi.js의 getTags·createTag·deleteTag와 같은 주소·메서드를 공통 요청 함수로 보낸다.
// videoApi.js는 Vite 전용 환경값을 읽어서 Node에서 직접 불러올 수 없다(마지막 시험이 소스로 같은 주소인지 지킨다).
const getTags = () => adminRequest('/api/tags');
const createTag = (name) => adminRequest('tags', { method: 'POST', body: JSON.stringify({ name }) });
const deleteTag = (id) => adminRequest(`tags/${id}`, { method: 'DELETE' });
const getVideo = (id) => adminRequest(`videos/${id}`);

test('FE 태그 관리(TagPicker) 흐름과 실제 서버 연동', async (t) => {
  const { request, login, getDb } = await startAuthServer(t);
  const { cookie } = await login();
  const db = getDb();
  const original = globalThis.fetch;
  let loggedIn = true;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (path, options = {}) => {
    const res = await request(path, {
      method: options.method, body: options.body,
      headers: { ...options.headers, Origin: 'http://localhost:5173' }, cookie: loggedIn ? cookie : '',
    });
    return new Response(res.status === 204 ? null : res.text, { status: res.status, headers: res.headers });
  };

  await t.test('태그를 만들면 { id, name }을 받고 태그 목록에 바로 보인다(TagPicker: createTag(name.trim()))', async () => {
    const tag = await createTag('  엑셀  '.trim());
    assert.deepEqual(Object.keys(tag), ['id', 'name']);
    assert.equal(tag.name, '엑셀');
    const list = await getTags();
    assert.ok(list.data.some((item) => item.id === tag.id && item.name === '엑셀'));
  });

  await t.test('중복 태그는 409 TAG_ALREADY_EXISTS이고 화면에 보여 줄 메시지가 있다(공백·대소문자만 달라도)', async () => {
    await createTag('Excel');
    for (const name of ['Excel', 'excel', 'EXCEL']) {
      await assert.rejects(createTag(name), (error) =>
        error.status === 409 && error.code === 'TAG_ALREADY_EXISTS' && /이미/.test(error.message) && !!error.fields.name);
    }
  });

  await t.test('빈 이름·너무 긴 이름은 400 필드 오류이다', async () => {
    await assert.rejects(createTag(''), (error) => error.status === 400 && !!error.fields.name);
    await assert.rejects(createTag('가'.repeat(31)), (error) => error.status === 400 && !!error.fields.name);
  });

  await t.test('태그를 지우면 204(null)이고, 그 태그가 붙어 있던 영상의 태그에서도 빠진다', async () => {
    const keep = await createTag('남길 태그');
    const drop = await createTag('지울 태그');
    const videoId = Number(db.prepare('INSERT INTO videos (title, description, video_path) VALUES (?, ?, ?)')
      .run('태그가 붙은 영상', '', `videos/${randomUUID()}.mp4`).lastInsertRowid);
    for (const tag of [keep, drop]) db.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(videoId, tag.id);

    assert.equal(await deleteTag(drop.id), null);
    assert.deepEqual((await getVideo(videoId)).tagIds, [keep.id], '영상은 남고 지운 태그만 빠진다');
    assert.equal((await getTags()).data.some((item) => item.id === drop.id), false);
    await assert.rejects(deleteTag(drop.id), (error) => error.status === 404 && error.code === 'NOT_FOUND');
  });

  await t.test('로그인이 풀렸으면 AUTH_REQUIRED 오류이고 아무것도 바뀌지 않는다', async () => {
    const tag = await createTag('로그인 풀린 뒤 태그');
    loggedIn = false;
    await assert.rejects(createTag('만들면 안 되는 태그'), (error) => error.code === 'AUTH_REQUIRED');
    await assert.rejects(deleteTag(tag.id), (error) => error.code === 'AUTH_REQUIRED');
    loggedIn = true;
    assert.equal((await getTags()).data.some((item) => item.name === '만들면 안 되는 태그'), false);
    assert.equal((await getTags()).data.some((item) => item.id === tag.id), true);
  });

  await t.test('videoApi.js의 createTag·deleteTag가 이 시험과 같은 주소·메서드를 쓰는지 소스로 지킨다', () => {
    const api = readFileSync(new URL('../src/api/videoApi.js', import.meta.url), 'utf8');
    assert.match(api, /adminRequest\('tags', \{ method: 'POST', body: JSON\.stringify\(\{ name \}\) \}\)/);
    assert.match(api, /adminRequest\(`tags\/\$\{id\}`, \{ method: 'DELETE' \}\)/);
    const picker = readFileSync(new URL('../src/components/admin/TagPicker.jsx', import.meta.url), 'utf8');
    assert.match(picker, /createTag\(name\.trim\(\)\)/);
  });
});
