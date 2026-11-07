import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { startAuthServer } from '../../backend/test/helpers/auth-server.js';
import { adminRequest } from '../src/api/adminApi.js';
import { getLearningCourse } from '../src/api/learnerApi.js';

// courseApi.js의 getCourses·getCourse·saveCourse·deleteCourse와 같은 주소·메서드를 공통 요청 함수로 보낸다.
// courseApi.js는 Vite 전용 환경값을 읽어서 Node에서 직접 불러올 수 없다(마지막 시험이 소스로 같은 주소인지 지킨다).
const getCourses = (page = 1) => adminRequest(`courses?page=${page}&limit=20`);
const getCourse = (id) => adminRequest(`courses/${id}`);
const saveCourse = (id, data) => adminRequest(id ? `courses/${id}` : 'courses', { method: id ? 'PUT' : 'POST', body: JSON.stringify(data) });
const deleteCourse = (id) => adminRequest(`courses/${id}`, { method: 'DELETE' });

// CourseEditor.jsx(86번째 줄 근처)가 저장할 때 만드는 payload와 같은 모양
const editorPayload = (form) => ({ name: form.name.trim(), description: form.description, videoIds: form.videos.map((video) => video.id) });
// CourseEditor.jsx가 오류를 보여 주는 칸(errors.name / errors.description / errors.videoIds)
const EDITOR_FIELDS = ['name', 'description', 'videoIds'];
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('FE 학습과정 편집기 흐름과 실제 서버 연동', async (t) => {
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
  const addVideo = (title) => Number(db.prepare('INSERT INTO videos (title, description, video_path) VALUES (?, ?, ?)')
    .run(title, '', `videos/${randomUUID()}.mp4`).lastInsertRowid);
  const [v1, v2, v3, v4] = ['첫째', '둘째', '셋째', '넷째'].map(addVideo);

  await t.test('새 학습과정: 편집기가 만든 payload로 만들면 순서대로 저장되고 목록에 보인다', async () => {
    const form = { name: '  엑셀 입문  ', description: '업무 기초', videos: [{ id: v3 }, { id: v1 }] };
    const created = await saveCourse(undefined, editorPayload(form));
    assert.equal(created.name, '엑셀 입문');
    assert.deepEqual(created.videos.map((video) => [video.id, video.sortOrder]), [[v3, 1], [v1, 2]]);

    const list = await getCourses(1);
    assert.equal(list.data[0].id, created.id);
    assert.equal(list.data[0].videoCount, 2);
  });

  await t.test('편집: 불러온 영상을 정렬해 폼에 채우고, 순서를 바꿔 저장하면 반영된다', async () => {
    const created = await saveCourse(undefined, { name: '순서 바꾸기', description: '', videoIds: [v1, v2, v3] });
    // CourseEditor.jsx(53번째 줄): sortOrder 순으로 정렬해 폼에 넣는다
    const course = await getCourse(created.id);
    const form = { name: course.name, description: course.description, videos: [...course.videos].sort((a, b) => a.sortOrder - b.sortOrder) };
    form.videos = [form.videos[2], form.videos[0], form.videos[1]]; // '셋째'를 맨 앞으로
    form.videos = form.videos.filter((video) => video.id !== v2); // '둘째'는 제외
    form.videos.push({ id: v4 }); // '넷째' 추가
    const saved = await saveCourse(created.id, editorPayload(form));
    assert.deepEqual(saved.videos.map((video) => [video.id, video.sortOrder]), [[v3, 1], [v1, 2], [v4, 3]]);
    assert.equal((await getCourse(created.id)).videoCount, 3);
  });

  await t.test('값이 그대로면 저장 버튼만 눌러도 아무것도 바뀌지 않는다(updatedAt 그대로)', async () => {
    const created = await saveCourse(undefined, { name: '그대로 과정', description: '설명', videoIds: [v1, v2] });
    await pause(15);
    const course = await getCourse(created.id);
    const saved = await saveCourse(created.id, editorPayload({ name: course.name, description: course.description, videos: course.videos }));
    assert.deepEqual(saved, created);
  });

  await t.test('서버가 돌려주는 오류 키는 모두 편집기의 칸 이름으로 이어진다', async () => {
    const bad = { name: 'a', description: 'x'.repeat(301), videoIds: [] };
    await assert.rejects(saveCourse(undefined, bad), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.deepEqual(Object.keys(error.fields).sort(), [...EDITOR_FIELDS].sort(), '세 칸 모두에 오류가 표시된다');
      return true;
    });
    await assert.rejects(saveCourse(undefined, { name: '이름입니다', videoIds: [v1, 999999] }), (error) =>
      error.status === 400 && /999999/.test(error.fields.videoIds));
    await assert.rejects(getCourse(999999), (error) => error.status === 404 && error.code === 'NOT_FOUND');
    await assert.rejects(saveCourse(999999, { name: '이름입니다', videoIds: [v1] }), (error) => error.status === 404);
  });

  await t.test('삭제: 204(null)로 성공하고 목록에서 사라지지만 영상은 남고, 학습자 화면에서도 사라진다', async () => {
    const created = await saveCourse(undefined, { name: '지울 과정', description: '', videoIds: [v1, v2] });
    assert.equal(await deleteCourse(created.id), null);
    await assert.rejects(getCourse(created.id), (error) => error.status === 404);
    await assert.rejects(getLearningCourse(created.id), (error) => error.status === 404);
    assert.equal((await getCourses(1)).data.some((course) => course.id === created.id), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM videos WHERE id IN (?, ?)').get(v1, v2).n, 2, '원본 영상은 남는다');
    await assert.rejects(deleteCourse(created.id), (error) => error.status === 404, '이미 지운 과정');
  });

  await t.test('수정한 구성이 학습자 화면에도 같은 순서로 보인다', async () => {
    const created = await saveCourse(undefined, { name: '학습자 화면 확인', description: '', videoIds: [v1, v2] });
    await saveCourse(created.id, { name: '학습자 화면 확인', description: '', videoIds: [v2, v3, v1] });
    const learner = await getLearningCourse(created.id);
    assert.deepEqual(learner.videos.map((video) => [video.id, video.sortOrder]), [[v2, 1], [v3, 2], [v1, 3]]);
  });

  await t.test('로그인이 풀렸으면 AUTH_REQUIRED 오류이고 아무것도 바뀌지 않는다', async () => {
    const created = await saveCourse(undefined, { name: '로그인 풀린 뒤', description: '', videoIds: [v1] });
    loggedIn = false;
    await assert.rejects(saveCourse(created.id, { name: '바뀌면 안 됨', videoIds: [v1] }), (error) => error.code === 'AUTH_REQUIRED');
    await assert.rejects(deleteCourse(created.id), (error) => error.code === 'AUTH_REQUIRED');
    loggedIn = true;
    assert.equal((await getCourse(created.id)).name, '로그인 풀린 뒤');
  });

  await t.test('courseApi.js와 CourseEditor.jsx가 이 시험과 같은 주소·payload를 쓰는지 소스로 지킨다', () => {
    const api = readFileSync(new URL('../src/api/courseApi.js', import.meta.url), 'utf8');
    assert.match(api, /adminRequest\(`courses\?page=\$\{page\}&limit=20`/);
    assert.match(api, /adminRequest\(`courses\/\$\{id\}`, \{ signal \}\)/);
    assert.match(api, /adminRequest\(id \? `courses\/\$\{id\}` : 'courses', \{ method: id \? 'PUT' : 'POST'/);
    assert.match(api, /adminRequest\(`courses\/\$\{id\}`, \{ method: 'DELETE' \}\)/);
    const editor = readFileSync(new URL('../src/components/admin/CourseEditor.jsx', import.meta.url), 'utf8');
    assert.match(editor, /saveCourse\(id, \{ name: form\.name\.trim\(\), description: form\.description, videoIds: form\.videos\.map\(\(video\) => video\.id\) \}\)/);
  });
});
