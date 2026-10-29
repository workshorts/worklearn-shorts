import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getFollowingVideoId, markCompleted, markStarted, readProgress, resetCourseProgress, summarizeCourse,
} from '../src/lib/courseProgress.js';
import { getVisitorId } from '../src/lib/visitorId.js';

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
}

const course = {
  id: 1,
  videos: [3, 1, 2, 4].map((id, index) => ({ id, sortOrder: index + 1 })), // 일부러 섞은 순서
};
const statuses = (summary) => summary.items.map((item) => `${item.videoId}:${item.status}`);

test('방문자 ID: 처음 만든 값을 저장하고 다음부터 같은 값을 쓴다', () => {
  const storage = fakeStorage();
  let created = 0;
  const createId = () => { created += 1; return '12345678-1234-4234-8234-123456789ABC'; };
  const first = getVisitorId({ storage, createId });
  assert.equal(first, '12345678-1234-4234-8234-123456789abc', '소문자로 맞춘다');
  assert.equal(getVisitorId({ storage, createId }), first);
  assert.equal(created, 1);
});

test('방문자 ID: 저장된 값이 UUID가 아니면 새로 만든다', () => {
  const storage = fakeStorage({ 'worklearn.visitorId': 'hello' });
  const id = getVisitorId({ storage });
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(storage.getItem('worklearn.visitorId'), id);
});

test('방문자 ID: 저장소가 막혀 있어도 값을 돌려준다', () => {
  const blocked = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  assert.match(getVisitorId({ storage: blocked }), /^[0-9a-f-]{36}$/);
});

test('진도 요약: 기록이 없으면 첫 영상이 next이고 나머지는 upcoming', () => {
  const summary = summarizeCourse(course);
  assert.deepEqual(statuses(summary), ['3:next', '1:upcoming', '2:upcoming', '4:upcoming']);
  assert.deepEqual([summary.completedCount, summary.totalCount, summary.percent, summary.isComplete], [0, 4, 0, false]);
  assert.deepEqual([summary.continueVideoId, summary.nextVideoId], [3, 3]);
});

test('진도 요약: 완료·학습 중·다음·예정이 학습 순서대로 정해진다', () => {
  const summary = summarizeCourse(course, { started: [3, 1], completed: [3] });
  assert.deepEqual(statuses(summary), ['3:completed', '1:in-progress', '2:next', '4:upcoming']);
  assert.deepEqual([summary.completedCount, summary.percent], [1, 25]);
  assert.equal(summary.continueVideoId, 1, '보던 영상을 이어서 본다');
  assert.equal(summary.nextVideoId, 2);
});

test('진도 요약: 모두 끝나면 100%이고 이어볼 영상이 없다', () => {
  const summary = summarizeCourse(course, { started: [1, 2, 3, 4], completed: [1, 2, 3, 4] });
  assert.deepEqual([summary.percent, summary.isComplete, summary.continueVideoId, summary.nextVideoId], [100, true, null, null]);
});

test('진도 요약: 과정에서 빠진 영상의 기록은 무시하고, 영상이 없는 과정도 처리한다', () => {
  const summary = summarizeCourse(course, { started: [99], completed: [99, 1] });
  assert.equal(summary.completedCount, 1);
  assert.deepEqual(summarizeCourse({ videos: [] }).percent, 0);
  assert.deepEqual(summarizeCourse(undefined).items, []);
});

test('진도 저장: 시작과 완료를 기록하고 다시 읽는다', () => {
  const storage = fakeStorage();
  markStarted(1, 3, storage);
  markStarted(1, 3, storage);
  markCompleted(1, 3, storage);
  markStarted(2, 5, storage);
  const progress = readProgress(storage);
  assert.deepEqual(progress.courses['1'], { started: [3], completed: [3] });
  assert.deepEqual(progress.courses['2'], { started: [5], completed: [] });
  assert.deepEqual(resetCourseProgress(1, storage).courses['1'], undefined);
  assert.ok(readProgress(storage).courses['2']);
});

test('진도 저장: 잘못된 입력과 망가진 저장값을 견딘다', () => {
  const storage = fakeStorage({ 'worklearn.courseProgress.v1': '{깨진 JSON' });
  assert.deepEqual(readProgress(storage), { version: 1, courses: {} });
  markCompleted(0, 1, storage);
  markCompleted(1, -5, storage);
  markCompleted('abc', 1, storage);
  assert.deepEqual(readProgress(storage).courses, {});

  const odd = fakeStorage({ 'worklearn.courseProgress.v1': JSON.stringify({ courses: { 1: { started: [1, 'x', 1.5, 1], completed: 'no' }, abc: {}, 2: null } }) });
  assert.deepEqual(readProgress(odd).courses, { 1: { started: [1], completed: [] } });

  const full = { getItem: () => null, setItem() { throw new Error('quota'); } };
  assert.doesNotThrow(() => markCompleted(1, 1, full));
});

test('다음 영상: 학습 순서상 바로 다음이고, 마지막이거나 없는 영상이면 null', () => {
  assert.equal(getFollowingVideoId(course, 3), 1);
  assert.equal(getFollowingVideoId(course, 2), 4);
  assert.equal(getFollowingVideoId(course, 4), null);
  assert.equal(getFollowingVideoId(course, 99), null);
});
