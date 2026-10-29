// 백엔드 없이 사용자 화면을 만들 때 켜는 미리보기. 개발 서버에서만 동작하고 프로덕션 빌드에서는 꺼진다.
// frontend/.env에 VITE_LEARNER_PREVIEW=true 를 적고 Vite를 다시 시작한다.
export const learnerPreview = import.meta.env?.DEV === true && import.meta.env?.VITE_LEARNER_PREVIEW === 'true';
