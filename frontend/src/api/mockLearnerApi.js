import { ApiError } from './adminApi.js';

// 개발 전용 가짜 데이터. 실제 API 응답(명세서 사용자 API 4·5)과 같은 모양이다.
// 새로고침하면 처음 상태로 돌아가고, 영상 파일이 없어서 videoUrl은 비어 있다.
const DEFAULT_THUMBNAIL = '/images/default-thumbnail.svg';
const titles = ['실무 엑셀 기초', '웹 개발 입문', '업무 자동화 입문', '직장인 비즈니스 매너', '직장인을 위한 IT 기초', '기획안 · 보고서 작성법', '데이터 분석 입문', '효율적인 커뮤니케이션'];
const tagNames = [['엑셀', '업무자동화'], ['개발'], ['개발', '업무자동화'], ['비즈니스 매너'], [], ['기획/PM'], ['데이터 분석', '엑셀'], ['비즈니스 매너']];
const viewCounts = [1254, 2480, 1892, 3521, 980, 2114, 3092, 1768];
const likeCounts = [98, 215, 173, 320, 64, 201, 278, 142];

const videos = titles.map((title, index) => ({
  id: index + 1,
  title,
  description: index === 4 ? '' : `${title}의 핵심을 짧게 배워보세요.`,
  tags: tagNames[index].map((name, tagIndex) => ({ id: index * 10 + tagIndex + 1, name })),
  videoUrl: '',
  thumbnailUrl: DEFAULT_THUMBNAIL,
  viewCount: viewCounts[index],
  likeCount: likeCounts[index],
  likedByMe: false,
  commentCount: 0,
  hasQuiz: index === 0,
  createdAt: new Date(Date.UTC(2026, 9, 15 - index)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 9, 15 - index)).toISOString(),
}));

// 배열 순서가 곧 학습 순서다. 같은 영상이 여러 과정에 들어갈 수 있다.
const courses = [
  { id: 1, name: '업무 효율 기초', description: '엑셀과 자동화로 일의 속도를 높이는 입문 과정', videoIds: [1, 3, 8] },
  { id: 2, name: '개발 시작하기', description: '웹 개발과 IT 기초를 처음부터 차근차근 배우는 과정', videoIds: [5, 2, 3] },
  { id: 3, name: '직장인 기본기', description: '매너, 보고서, 커뮤니케이션까지 일하는 방식의 기본', videoIds: [4, 6, 8] },
].map((course) => ({ ...course, createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z' }));

const copy = (value) => structuredClone(value);
async function delay(signal) {
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}
// 실제 응답과 같은 필드 순서로 만든다.
const summary = ({ id, name, description, videoIds, createdAt, updatedAt }) => ({ id, name, description, videoCount: videoIds.length, createdAt, updatedAt });

export async function getCourses(page, limit, signal) {
  await delay(signal);
  if (!Number.isSafeInteger(page) || page < 1) throw new ApiError('입력값을 확인하세요.', 400, { page: '페이지는 1 이상의 정수로 입력하세요.' }, 'VALIDATION_ERROR');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new ApiError('입력값을 확인하세요.', 400, { limit: '페이지당 항목 수는 1 이상 50 이하의 정수로 입력하세요.' }, 'VALIDATION_ERROR');
  const ordered = [...courses].sort((a, b) => b.id - a.id); // 실제 API처럼 id 내림차순
  return { data: copy(ordered.slice((page - 1) * limit, page * limit).map(summary)), page, limit, total: courses.length };
}

export async function getCourse(id, signal) {
  await delay(signal);
  const course = courses.find((candidate) => candidate.id === id);
  if (!course) throw new ApiError('학습과정을 찾을 수 없습니다.', 404, undefined, 'NOT_FOUND');
  return copy({
    ...summary(course),
    videos: course.videoIds.map((videoId, index) => ({ ...videos.find((video) => video.id === videoId), sortOrder: index + 1 })),
  });
}
