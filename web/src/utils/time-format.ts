// 消息时间与耗时的展示格式。都按本地时区，和系统时钟保持一致。

const pad = (value: number) => String(value).padStart(2, '0')

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export interface MessageTimeLabel {
  /** 界面上显示的短文本：今天只显示时刻，越久远带上越多日期 */
  label: string
  /** 悬停提示里的完整时间 */
  full: string
  /** <time datetime> 用的 ISO 字符串 */
  iso: string
}

export function formatMessageTime(timestamp: number, now: number = Date.now()): MessageTimeLabel {
  const date = new Date(timestamp)
  const today = new Date(now)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)

  let label: string
  if (isSameDay(date, today)) label = clock
  else if (isSameDay(date, yesterday)) label = `昨天 ${clock}`
  else if (date.getFullYear() === today.getFullYear()) label = `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
  else label = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clock}`

  const full = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}:${pad(date.getSeconds())}`
  return { label, full, iso: date.toISOString() }
}

/** 耗时：1 秒内用毫秒，1 分钟内保留一位小数，再往上换成分秒、时分 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m ${pad(totalSeconds % 60)}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  return `${Math.floor(totalMinutes / 60)}h ${pad(totalMinutes % 60)}m`
}
