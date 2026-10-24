// 메모리에 시도 횟수를 기록하는 간단한 제한기 (서버를 다시 켜면 기록이 사라진다)
export function createLimiter({ windowMs, max }) {
  const entries = new Map() // key -> { count, resetAt }

  function current(key) {
    const entry = entries.get(key)
    if (entry && entry.resetAt <= Date.now()) {
      entries.delete(key)
      return null
    }
    return entry ?? null
  }

  // 막혀 있으면 남은 시간(초), 아니면 0
  function blockedSeconds(key) {
    const entry = current(key)
    if (!entry || entry.count < max) return 0
    return Math.ceil((entry.resetAt - Date.now()) / 1000)
  }

  // 시도 1회를 기록한다
  function hit(key) {
    const entry = current(key)
    if (entry) entry.count += 1
    else entries.set(key, { count: 1, resetAt: Date.now() + windowMs })
  }

  function reset(key) {
    entries.delete(key)
  }

  // 오래된 기록을 주기적으로 지운다
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of entries) {
      if (entry.resetAt <= now) entries.delete(key)
    }
  }, windowMs)
  timer.unref()

  return { blockedSeconds, hit, reset }
}