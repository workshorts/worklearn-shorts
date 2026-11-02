import assert from 'node:assert/strict';
import test from 'node:test';
import { startAuthServer } from '../../backend/test/helpers/auth-server.js';
import { ApiError } from '../src/api/adminApi.js';
import { recordVideoView, setVideoLike } from '../src/api/feedApi.js';
import { addWatchTime, VIEW_THRESHOLD_SECONDS, watchedDelta } from '../src/lib/watchTime.js';

// 피드 좋아요·조회수 요청 함수를 실제 백엔드(임시 DB)에 연결해 확인한다.
test('피드 좋아요·조회수 API 연동', async (t) => {
  const { request, getDb } = await startAuthServer(t);
  const db = getDb();
  const original = globalThis.fetch;
  const calls = [];
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (path, options = {}) => {
    calls.push({ path, method: options.method ?? 'GET', headers: options.headers ?? {} });
    const res = await request(path, { method: options.method, body: options.body, headers: options.headers });
    return new Response(res.status === 204 ? null : res.text, { status: res.status, headers: res.headers });
  };
  const videoId = Number(db.prepare('INSERT INTO videos (title, video_path) VALUES (?, ?)')
    .run('엑셀 단축키', `videos/${crypto.randomUUID()}.mp4`).lastInsertRowid);

  await t.test('조회 기록: 방문자당 한 번만 센다', async () => {
    const first = await recordVideoView(videoId);
    assert.deepEqual(first, { videoId, viewCount: 1, counted: true });
    assert.equal(calls.at(-1).method, 'POST');
    assert.equal(calls.at(-1).path, `/api/videos/${videoId}/view`);
    assert.match(calls.at(-1).headers['X-Visitor-Id'], /^[0-9a-f-]{36}$/);
    const again = await recordVideoView(videoId);
    assert.deepEqual(again, { videoId, viewCount: 1, counted: false });
  });

  await t.test('좋아요: 추가·중복 추가·취소', async () => {
    assert.deepEqual(await setVideoLike(videoId, true), { videoId, likeCount: 1, likedByMe: true });
    assert.equal(calls.at(-1).method, 'PUT');
    assert.deepEqual(await setVideoLike(videoId, true), { videoId, likeCount: 1, likedByMe: true });
    assert.deepEqual(await setVideoLike(videoId, false), { videoId, likeCount: 0, likedByMe: false });
    assert.equal(calls.at(-1).method, 'DELETE');
    assert.deepEqual(await setVideoLike(videoId, false), { videoId, likeCount: 0, likedByMe: false });
  });

  await t.test('없는 영상과 잘못된 번호', async () => {
    await assert.rejects(setVideoLike(999999, true), (error) => error instanceof ApiError && error.status === 404);
    await assert.rejects(recordVideoView(999999), (error) => error instanceof ApiError && error.status === 404);
    const before = calls.length;
    await assert.rejects(setVideoLike(0, true), (error) => error.code === 'VALIDATION_ERROR');
    await assert.rejects(recordVideoView('1'), (error) => error.code === 'VALIDATION_ERROR');
    assert.equal(calls.length, before, '잘못된 번호는 요청을 보내지 않는다');
  });
});

test('누적 재생 시간 계산', () => {
  assert.equal(watchedDelta(null, 0.3), 0, '첫 이벤트는 기준점만 잡는다');
  assert.equal(Math.round(watchedDelta(1, 1.25) * 100), 25);
  assert.equal(watchedDelta(5, 30), 0, '앞으로 탐색한 구간은 세지 않는다');
  assert.equal(watchedDelta(14, 0.2), 0, '반복 재생으로 처음에 돌아가면 세지 않는다');

  let total = 0;
  let reachedAt = null;
  for (let step = 1; step <= 50; step += 1) {
    const result = addWatchTime(total, 0.25);
    total = result.total;
    if (result.reached) { assert.equal(reachedAt, null, '기준은 한 번만 넘는다'); reachedAt = step; }
  }
  assert.equal(reachedAt, VIEW_THRESHOLD_SECONDS / 0.25);
});
