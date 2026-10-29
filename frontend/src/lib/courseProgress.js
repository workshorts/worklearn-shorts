import { getBrowserStorage } from './storage.js';

// 학습 진도: 서버가 아니라 브라우저에 저장한다(로그인이 없으므로 이 브라우저 기준).
// 영상 하나의 상태는 아래 넷 중 하나다.
//   completed   끝까지 봄
//   in-progress 재생을 시작했지만 끝까지 보지 않음
//   next        다음에 새로 볼 영상 (과정에서 한 개)
//   upcoming    아직 순서가 오지 않음
const STORAGE_KEY = 'worklearn.courseProgress.v1';

const isId = (value) => Number.isSafeInteger(value) && value > 0;
const uniqueIds = (values) => [...new Set(Array.isArray(values) ? values.filter(isId) : [])];

// 저장된 값이 망가져 있어도 화면이 깨지지 않게 형식을 다시 확인한다.
export function readProgress(storage = getBrowserStorage()) {
  let saved = {};
  try {
    const text = storage.getItem(STORAGE_KEY);
    const parsed = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
  } catch {
    saved = {};
  }

  const courses = {};
  for (const [courseId, record] of Object.entries(saved.courses ?? {})) {
    if (!isId(Number(courseId)) || record === null || typeof record !== 'object') continue;
    courses[courseId] = { started: uniqueIds(record.started), completed: uniqueIds(record.completed) };
  }
  return { version: 1, courses };
}

function writeProgress(progress, storage) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // 저장 공간이 없어도 화면은 계속 동작해야 한다.
  }
}

function update(courseId, videoId, change, storage) {
  if (!isId(courseId) || !isId(videoId)) return readProgress(storage);
  const progress = readProgress(storage);
  const record = progress.courses[courseId] ?? { started: [], completed: [] };
  progress.courses[courseId] = change(record);
  writeProgress(progress, storage);
  return progress;
}

// 영상 재생을 시작했을 때 부른다.
export function markStarted(courseId, videoId, storage = getBrowserStorage()) {
  return update(courseId, videoId, (record) => ({
    ...record,
    started: uniqueIds([...record.started, videoId]),
  }), storage);
}

// 영상을 끝까지 봤을 때 부른다. 끝까지 본 영상은 '학습 중'에서 빠진다.
export function markCompleted(courseId, videoId, storage = getBrowserStorage()) {
  return update(courseId, videoId, (record) => ({
    started: uniqueIds([...record.started, videoId]),
    completed: uniqueIds([...record.completed, videoId]),
  }), storage);
}

// 과정의 진도를 처음부터 다시 시작한다.
export function resetCourseProgress(courseId, storage = getBrowserStorage()) {
  const progress = readProgress(storage);
  delete progress.courses[courseId];
  writeProgress(progress, storage);
  return progress;
}

// 과정 상세(GET /api/courses/:id의 응답)와 저장된 기록으로 화면에 필요한 값을 계산한다.
// 과정에서 빠진 영상의 기록은 무시한다(관리자가 과정을 고친 경우).
export function summarizeCourse(course, record = { started: [], completed: [] }) {
  const videos = [...(course?.videos ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const completed = new Set(record.completed);
  const started = new Set(record.started);

  const inProgressIds = videos
    .filter((video) => started.has(video.id) && !completed.has(video.id))
    .map((video) => video.id);
  const nextVideo = videos.find((video) => !completed.has(video.id) && !started.has(video.id));

  const items = videos.map((video) => {
    let status = 'upcoming';
    if (completed.has(video.id)) status = 'completed';
    else if (started.has(video.id)) status = 'in-progress';
    else if (video.id === nextVideo?.id) status = 'next';
    return { videoId: video.id, sortOrder: video.sortOrder, status };
  });

  const completedCount = items.filter((item) => item.status === 'completed').length;
  const firstUnfinished = videos.find((video) => !completed.has(video.id));
  return {
    items,
    totalCount: videos.length,
    completedCount,
    percent: videos.length === 0 ? 0 : Math.round((completedCount / videos.length) * 100),
    isComplete: videos.length > 0 && completedCount === videos.length,
    // '이어보기' 버튼이 가리킬 영상: 보던 영상이 있으면 그것, 없으면 아직 안 끝낸 첫 영상. 모두 끝났으면 null.
    continueVideoId: inProgressIds[0] ?? firstUnfinished?.id ?? null,
    nextVideoId: nextVideo?.id ?? null,
  };
}

// 영상이 끝났을 때 [다음 영상]이 가리킬 영상: 학습 순서상 바로 다음 영상. 마지막이면 null.
export function getFollowingVideoId(course, videoId) {
  const videos = [...(course?.videos ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const index = videos.findIndex((video) => video.id === videoId);
  return index >= 0 && index < videos.length - 1 ? videos[index + 1].id : null;
}
