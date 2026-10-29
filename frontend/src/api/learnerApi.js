import { ApiError } from './adminApi.js';
import { learnerPreview } from './learnerPreview.js';
import { getVisitorId } from '../lib/visitorId.js';

// 학습자(사용자) 화면용 API 함수. 로그인이 필요 없는 요청만 있다.
// - 성공하면 API 명세서의 응답 JSON을 그대로 돌려준다.
// - 실패하면 ApiError(message, status, fields, code)를 던진다. message는 화면에 그대로 보여 줘도 된다.
// - signal에 AbortController의 signal을 넘기면 화면을 떠날 때 요청을 취소할 수 있다.
// 미리보기(VITE_LEARNER_PREVIEW=true)에서는 mockLearnerApi.js의 가짜 데이터를 같은 모양으로 돌려준다.
const mock = learnerPreview ? import('./mockLearnerApi.js') : null;
const call = (name, args, request) => (mock ? mock.then((module) => module[name](...args)) : request());

const messageFor = (status, data) =>
  status === 429 ? '요청이 많습니다. 잠시 후 다시 시도해 주세요.' :
  status >= 500 ? '서버가 준비 중이거나 응답하지 않습니다. 잠시 후 다시 시도해 주세요.' :
  data?.message || (status === 404 ? '요청한 내용을 찾을 수 없습니다.' : '요청을 처리하지 못했습니다. 다시 시도해 주세요.');

export async function learnerRequest(path, { signal, timeoutMs = 25_000, visitor = false, ...options } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(path, {
      ...options,
      headers: { ...(visitor ? { 'X-Visitor-Id': getVisitorId() } : {}), ...options.headers },
      signal: controller.signal,
    });
    const isJson = response.headers.get('content-type')?.includes('application/json');
    const data = isJson ? await response.json() : null;
    if (!response.ok) throw new ApiError(messageFor(response.status, data), response.status, data?.fields, data?.code);
    // 개발 서버가 API 대신 화면 HTML을 돌려주는 경우를 성공으로 착각하지 않는다.
    if (!isJson && response.status !== 204) throw new ApiError('서버 연결을 확인해 주세요.', 502);
    return data;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      error.name === 'AbortError'
        ? '서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.'
        : '서버에 연결할 수 없습니다. 네트워크 연결을 확인하고 다시 시도해 주세요.',
      0,
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

// 이상한 값으로 주소가 만들어지지 않게, 요청 전에 학습과정 번호를 확인한다.
function courseIdOf(id) {
  const value = typeof id === 'string' && /^[0-9]+$/.test(id) ? Number(id) : id;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApiError('학습과정 번호가 올바르지 않습니다.', 400, { id: '학습과정 번호는 1 이상의 정수여야 합니다.' }, 'VALIDATION_ERROR');
  }
  return value;
}

// GET /api/courses → { data: Course[], page, limit, total }  (Course: id, name, description, videoCount, createdAt, updatedAt)
export function getLearningCourses({ page = 1, limit = 20, signal } = {}) {
  return call('getCourses', [page, limit, signal], () => {
    const query = new URLSearchParams({ page: String(page), limit: String(limit) });
    return learnerRequest(`/api/courses?${query}`, { signal });
  });
}

// GET /api/courses/:id → CourseDetail (videos가 학습 순서대로, 각 영상에 sortOrder 포함)
// 방문자 ID(X-Visitor-Id)를 함께 보내서 영상별 likedByMe가 채워진다.
// async 함수라서 잘못된 번호도 던지지 않고 거절(reject)로 돌려주므로 .catch()나 try/await로 받으면 된다.
export async function getLearningCourse(id, { signal } = {}) {
  const courseId = courseIdOf(id);
  return call('getCourse', [courseId, signal], () => learnerRequest(`/api/courses/${courseId}`, { signal, visitor: true }));
}
