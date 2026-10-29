import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { startAuthServer } from '../../backend/test/helpers/auth-server.js';
import { adminRequest } from '../src/api/adminApi.js';
import { getLearningCourse } from '../src/api/learnerApi.js';

// 시험용 최소 파일: 형식을 알아볼 수 있는 시그니처만 담았다(재생 가능한 영상이 아니다).
const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');

// AdminVideos가 삭제할 때 하는 일: deleteVideo(id) → 성공하면 목록을 다시 불러온다.
// videoApi.js는 Vite 전용 환경값을 읽어서 Node에서 직접 불러올 수 없어, 같은 요청을 공통 요청 함수로 보낸다.
const getVideos = (page = 1) => adminRequest(`videos?page=${page}&limit=20`);
const getVideo = (id) => adminRequest(`videos/${id}`);
const deleteVideo = (id) => adminRequest(`videos/${id}`, { method: 'DELETE' });
function upload(kind, file) {
  const body = new FormData();
  body.append('kind', kind);
  body.append('file', file);
  return adminRequest('uploads', { method: 'POST', body, timeoutMs: 120_000 });
}

test('FE 영상 삭제 흐름과 실제 서버 연동', async (t) => {
  const { request, login, getDb } = await startAuthServer(t, { uploads: true });
  const { cookie } = await login();
  const db = getDb();
  const original = globalThis.fetch;
  let loggedIn = true;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (path, options = {}) => {
    let body = options.body;
    const headers = { ...options.headers, Origin: 'http://localhost:5173' };
    if (body instanceof FormData) {
      const encoded = new Response(body); // 브라우저와 같은 방식의 멀티파트
      headers['Content-Type'] = encoded.headers.get('content-type');
      body = Buffer.from(await encoded.arrayBuffer());
    }
    const res = await request(path, { method: options.method, body, headers, cookie: loggedIn ? cookie : '' });
    return new Response(res.status === 204 ? null : res.text, { status: res.status, headers: res.headers });
  };

  async function register(title) {
    const videoPath = (await upload('video', new File([MP4], 'a.mp4', { type: 'video/mp4' }))).path;
    return adminRequest('videos', { method: 'POST', body: JSON.stringify({ title, videoPath }) });
  }

  await t.test('삭제하면 응답 본문 없이 성공하고, 목록과 편집 정보에서 사라진다', async () => {
    const keep = await register('남길 영상');
    const target = await register('지울 영상');
    assert.equal(await deleteVideo(target.id), null, '204는 null로 전달된다');

    const list = await getVideos(1);
    assert.deepEqual(list.data.map((video) => video.id), [keep.id]);
    assert.equal(list.total, 1);
    await assert.rejects(getVideo(target.id), (error) => error.status === 404 && error.code === 'NOT_FOUND');
  });

  await t.test('이미 지운 영상을 다시 지우면 404 오류 코드로 전달된다(다른 탭에서 먼저 지운 경우)', async () => {
    const video = await register('두 번 지우는 영상');
    await deleteVideo(video.id);
    await assert.rejects(deleteVideo(video.id), (error) => error.status === 404 && error.code === 'NOT_FOUND' && typeof error.message === 'string');
  });

  await t.test('학습과정에 들어 있던 영상을 지우면 학습자 화면에서도 빠지고 순서가 1부터 이어진다', async () => {
    const [first, second, third] = [await register('첫째'), await register('둘째'), await register('셋째')];
    const courseId = Number(db.prepare('INSERT INTO courses (name, description) VALUES (?, ?)').run('삭제 확인 과정', '').lastInsertRowid);
    [first, second, third].forEach((video, index) => {
      db.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)').run(courseId, video.id, index + 1);
    });

    await deleteVideo(first.id);
    const course = await getLearningCourse(courseId);
    assert.deepEqual(course.videos.map((video) => [video.id, video.sortOrder]), [[second.id, 1], [third.id, 2]]);
    assert.equal(course.videoCount, 2);
  });

  await t.test('로그인이 풀렸으면 삭제는 AUTH_REQUIRED 오류이고 영상은 남는다', async () => {
    const video = await register('로그인 풀린 뒤 삭제');
    loggedIn = false;
    await assert.rejects(deleteVideo(video.id), (error) => error.code === 'AUTH_REQUIRED');
    loggedIn = true;
    assert.equal((await getVideo(video.id)).id, video.id);
  });

  await t.test('videoApi.js의 deleteVideo가 DELETE videos/{id}로 보내는지 소스로 지킨다', () => {
    const source = readFileSync(new URL('../src/api/videoApi.js', import.meta.url), 'utf8');
    assert.match(source, /adminRequest\(`videos\/\$\{id\}`, \{ method: 'DELETE' \}\)/);
  });
});
