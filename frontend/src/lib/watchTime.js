// 조회수 기준: 영상별 누적 재생 10초. 탐색(seek)이나 반복 재생으로 시간이 크게 뛰면 그 구간은 세지 않는다.
export const VIEW_THRESHOLD_SECONDS = 10
const MAX_STEP_SECONDS = 1.5

// timeupdate 이벤트의 이전·현재 재생 위치로 이번에 실제로 본 시간을 계산한다.
export function watchedDelta(previousTime, currentTime) {
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) return 0
  const delta = currentTime - previousTime
  return delta > 0 && delta <= MAX_STEP_SECONDS ? delta : 0
}

// 누적 시간에 더하고, 이번에 기준을 처음 넘었는지 알려준다.
export function addWatchTime(total, delta, threshold = VIEW_THRESHOLD_SECONDS) {
  const next = total + Math.max(0, delta)
  return { total: next, reached: total < threshold && next >= threshold }
}
