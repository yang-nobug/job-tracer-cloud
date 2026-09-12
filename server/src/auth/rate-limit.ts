interface RateWindow {
  startedAt: number
  count: number
}

const windows = new Map<string, RateWindow>()

/** 单进程轻量限流。正式多实例部署时替换为 Redis 或数据库限流。 */
export function allowAttempt(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const current = windows.get(key)
  if (!current || now - current.startedAt >= windowMs) {
    windows.set(key, { startedAt: now, count: 1 })
    return true
  }
  if (current.count >= limit) return false
  current.count += 1
  return true
}
