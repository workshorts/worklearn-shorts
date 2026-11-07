import { learnerRequest } from './learnerApi.js'

// 정답 설정을 포함한 공개 퀴즈만 조회, 사용자 선택을 저장하는 요청은 없음
export const getVideoQuiz = (videoId, signal) => learnerRequest(`/api/videos/${videoId}/quiz`, { signal })
