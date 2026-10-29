import assert from 'node:assert/strict';
import test from 'node:test';
import { startAuthServer } from '../../backend/test/helpers/auth-server.js';
import { ApiError } from '../src/api/adminApi.js';
import { getLearningCourse, getLearningCourses, learnerRequest } from '../src/api/learnerApi.js';
import * as mock from '../src/api/mockLearnerApi.js';

// 실제 백엔드(임시 DB)에 요청하는 통합 시험이다. Node에는 Vite 프록시가 없으므로 fetch만 서버로 연결한다.
// 브라우저 화면·프록시 검증을 대체하지 않는다.
const uuidPath = (folder, extension) => `${folder}/${crypto.randomUUID()}.${extension}`;

test('학습자 API 요청 함수와 실제 학습과정 API 연동', async (t) => {
  const { request, getDb } = await startAuthServer(t);
  const db = getDb();
  const original = globalThis.fetch;
  const calls = [];
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (path, options = {}) => {
    calls.push({ path, headers: options.headers ?? {}, credentials: options.credentials });
    const res = await request(path, { method: options.method, body: options.body, headers: options.headers });
    return new Response(res.status === 204 ? null : res.text, { status: res.status, headers: res.headers });
  };

  const addVideo = (title, thumbnail) => Number(db.prepare(
    'INSERT INTO videos (title, description, video_path, thumbnail_path) VALUES (?, ?, ?, ?)',
  ).run(title, `${title} 설명`, uuidPath('videos', 'mp4'), thumbnail).lastInsertRowid);
  const v1 = addVideo('단축키', uuidPath('thumbnails', 'png'));
  const v2 = addVideo('자동 채우기', null);
  const insertCourse = db.prepare('INSERT INTO courses (name, description) VALUES (?, ?)');
  const link = db.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)');
  const courseA = Number(insertCourse.run('엑셀 입문', '업무 기초').lastInsertRowid);
  link.run(courseA, v2, 1);
  link.run(courseA, v1, 2);
  const courseB = Number(insertCourse.run('빈 과정', '').lastInsertRowid);

  await t.test('목록: 응답 모양과 page·limit 전달', async () => {
    const result = await getLearningCourses({ page: 1, limit: 1 });
    assert.deepEqual([result.page, result.limit, result.total], [1, 1, 2]);
    assert.deepEqual(result.data.map((course) => course.id), [courseB]);
    assert.deepEqual(Object.keys(result.data[0]), ['id', 'name', 'description', 'videoCount', 'createdAt', 'updatedAt']);
    assert.equal(calls.at(-1).path, '/api/courses?page=1&limit=1');
    assert.equal(calls.at(-1).headers['X-Visitor-Id'], undefined, '목록은 방문자 ID를 보내지 않는다');
  });

  await t.test('상세: 영상이 학습 순서대로 오고 방문자 ID를 보낸다', async () => {
    const course = await getLearningCourse(courseA);
    assert.deepEqual(course.videos.map((video) => [video.id, video.sortOrder]), [[v2, 1], [v1, 2]]);
    assert.equal(course.videoCount, 2);
    assert.equal(course.videos[0].thumbnailUrl, '/images/default-thumbnail.svg');
    assert.match(course.videos[1].thumbnailUrl, /^\/uploads\/thumbnails\//);
    assert.match(calls.at(-1).headers['X-Visitor-Id'], /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(calls.at(-1).path, `/api/courses/${courseA}`);
  });

  await t.test('상세: 문자열 번호도 받고, 영상이 없는 과정도 처리한다', async () => {
    const course = await getLearningCourse(String(courseB));
    assert.deepEqual([course.videos, course.videoCount], [[], 0]);
  });

  await t.test('미리보기 가짜 데이터가 실제 응답과 같은 모양이다', async () => {
    const realList = await getLearningCourses({ limit: 1 });
    const fakeList = await mock.getCourses(1, 1);
    assert.deepEqual(Object.keys(fakeList), Object.keys(realList));
    assert.deepEqual(Object.keys(fakeList.data[0]), Object.keys(realList.data[0]));

    const real = await getLearningCourse(courseA);
    const fake = await mock.getCourse(1);
    assert.deepEqual(Object.keys(fake), Object.keys(real));
    assert.deepEqual(Object.keys(fake.videos[0]).sort(), Object.keys(real.videos[0]).sort());
    assert.deepEqual(Object.keys(fake.videos[0].tags[0] ?? {}).sort(), ['id', 'name']);
    assert.deepEqual(fake.videos.map((video) => video.sortOrder), [1, 2, 3]);
    assert.equal(fake.videoCount, fake.videos.length);
    await assert.rejects(mock.getCourse(999), (error) => error.status === 404 && error.code === 'NOT_FOUND');
    await assert.rejects(mock.getCourses(1, 51), (error) => !!error.fields.limit);
  });

  await t.test('없는 과정은 서버 메시지와 함께 NOT_FOUND', async () => {
    await assert.rejects(getLearningCourse(999999), (error) =>
      error instanceof ApiError && error.status === 404 && error.code === 'NOT_FOUND' && /학습과정/.test(error.message));
  });

  await t.test('잘못된 번호는 요청을 보내기 전에 거절한다', async () => {
    const before = calls.length;
    for (const id of ['abc', 0, -1, 1.5, '1;DROP', '../admin', undefined, null, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(getLearningCourse(id), (error) => error.status === 400 && error.code === 'VALIDATION_ERROR' && !!error.fields.id, String(id));
    }
    assert.equal(calls.length, before);
  });

  await t.test('서버의 필드 검증 결과를 그대로 전달한다', async () => {
    await assert.rejects(getLearningCourses({ limit: 51 }), (error) => error.status === 400 && error.code === 'VALIDATION_ERROR' && !!error.fields.limit);
    await assert.rejects(getLearningCourses({ page: 0 }), (error) => !!error.fields.page);
  });

  await t.test('화면 HTML을 성공으로 처리하지 않고, 서버 오류와 연결 실패를 구분한다', async () => {
    globalThis.fetch = async () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } });
    await assert.rejects(learnerRequest('/api/courses'), (error) => error.status === 502);

    globalThis.fetch = async () => new Response(JSON.stringify({ code: 'INTERNAL_ERROR', message: 'x', fields: {} }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(learnerRequest('/api/courses'), (error) => error.status === 500 && /서버가 준비 중/.test(error.message));

    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(learnerRequest('/api/courses'), (error) => error.status === 0 && /연결할 수 없습니다/.test(error.message));

    globalThis.fetch = async () => new Response(JSON.stringify({ code: 'RATE_LIMITED' }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(learnerRequest('/api/courses'), (error) => error.status === 429);
  });

  await t.test('요청을 취소하면 취소 오류를 그대로 던진다', async () => {
    const controller = new AbortController();
    globalThis.fetch = (_path, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
    const pending = getLearningCourses({ signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => error.name === 'AbortError');
  });

  await t.test('응답이 너무 늦으면 지연 안내 오류로 바꾼다', async () => {
    globalThis.fetch = (_path, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
    await assert.rejects(learnerRequest('/api/courses', { timeoutMs: 20 }), (error) => error.status === 0 && /지연/.test(error.message));
  });
});
