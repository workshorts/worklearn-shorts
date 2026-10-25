export const blankQuiz = () => ({ enabled: false, question: '', options: [{ key: crypto.randomUUID(), content: '', isCorrect: false }, { key: crypto.randomUUID(), content: '', isCorrect: false }] })
export function readQuiz(quiz) {
  return quiz ? { enabled: true, question: quiz.question, options: quiz.options.map((option) => ({ key: crypto.randomUUID(), content: option.content, isCorrect: option.isCorrect })) } : blankQuiz()
}
export function fileError(kind, file) {
  if (!file) return ''
  const video = kind === 'video'
  const extensions = video ? /\.(mp4|webm)$/i : /\.(png|jpe?g|webp)$/i
  const mime = video ? ['video/mp4', 'video/webm'] : ['image/png', 'image/jpeg', 'image/webp']
  if (!extensions.test(file.name) || (file.type && !mime.includes(file.type))) return video ? 'MP4, WebM 형식만 업로드할 수 있습니다.' : 'PNG, JPG, WebP 형식만 업로드할 수 있습니다.'
  if (!file.size) return '비어 있는 파일은 업로드할 수 없습니다.'
  if (file.size > (video ? 50 : 10) * 1024 * 1024) return `파일 크기는 ${video ? 50 : 10}MB 이하여야 합니다.`
  return ''
}
export function routeLink(event, navigate, href) {
  if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault(); navigate(href)
}
