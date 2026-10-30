// sample-media.zip에 포함된 공통 샘플 8개로 피드를 미리 확인
// 각자 backend/uploads/에 샘플데이터 압축을 풀고 백엔드를 실행, DB 조회는 아직 하지 않는다
export const feedPreviewVideos = [
  ['실무 엑셀 기초', 'mp4', 'png', '엑셀'],
  ['웹 개발 입문', 'webm', 'webp', '개발'],
  ['업무 자동화 입문', 'mp4', null, '업무자동화'],
  ['직장인 비즈니스 매너', 'mp4', 'jpg', '비즈니스 매너'],
  ['직장인을 위한 IT 기초', 'mp4', null, '개발'],
  ['기획안 · 보고서 작성법', 'mp4', 'png', '기획/PM'],
  ['데이터 분석 입문', 'webm', 'webp', '데이터 분석'],
  ['효율적인 커뮤니케이션', 'mp4', null, '비즈니스 매너'],
].map(([title, extension, thumbnailExtension, tag], index) => {
  const suffix = String(index + 1).padStart(12, '0')
  return {
    id: index + 1, title, description: `${title}의 핵심을 짧게 배워보세요.`,
    tags: [{ id: index + 1, name: tag }],
    videoUrl: `/uploads/videos/10000000-0000-4000-8000-${suffix}.${extension}`,
    thumbnailUrl: thumbnailExtension ? `/uploads/thumbnails/20000000-0000-4000-8000-${suffix}.${thumbnailExtension}` : '',
    viewCount: 0, likeCount: 0, likedByMe: false, commentCount: 0, hasQuiz: false,
  }
})
