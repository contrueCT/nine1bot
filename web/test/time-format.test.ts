import { describe, expect, it } from 'bun:test'
import { formatDuration, formatMessageTime } from '../src/utils/time-format'

// 用本地时间构造，断言不受运行机器的时区影响
const now = new Date(2026, 8, 30, 15, 20, 0).getTime()

describe('formatMessageTime', () => {
  it('shows only the clock for today', () => {
    expect(formatMessageTime(new Date(2026, 8, 30, 9, 5, 7).getTime(), now).label).toBe('09:05')
  })

  it('prefixes yesterday, including across a month boundary', () => {
    expect(formatMessageTime(new Date(2026, 8, 29, 23, 59).getTime(), now).label).toBe('昨天 23:59')
    const firstOfMonth = new Date(2026, 9, 1, 8, 0).getTime()
    expect(formatMessageTime(new Date(2026, 8, 30, 22, 10).getTime(), firstOfMonth).label).toBe('昨天 22:10')
  })

  it('adds the date within the same year and the year otherwise', () => {
    expect(formatMessageTime(new Date(2026, 2, 3, 14, 0).getTime(), now).label).toBe('3月3日 14:00')
    expect(formatMessageTime(new Date(2025, 11, 31, 18, 30).getTime(), now).label).toBe('2025年12月31日 18:30')
  })

  it('provides a full timestamp and an ISO value', () => {
    const time = new Date(2026, 8, 30, 9, 5, 7)
    const result = formatMessageTime(time.getTime(), now)
    expect(result.full).toBe('2026-09-30 09:05:07')
    expect(result.iso).toBe(time.toISOString())
  })
})

describe('formatDuration', () => {
  it('uses milliseconds below one second', () => {
    expect(formatDuration(44)).toBe('44ms')
  })

  it('keeps one decimal below one minute', () => {
    expect(formatDuration(1234)).toBe('1.2s')
    expect(formatDuration(42_050)).toBe('42.0s')
  })

  it('switches to minutes and hours', () => {
    expect(formatDuration(125_000)).toBe('2m 05s')
    expect(formatDuration(3_725_000)).toBe('1h 02m')
  })

  it('returns an empty string for invalid input', () => {
    expect(formatDuration(-1)).toBe('')
    expect(formatDuration(Number.NaN)).toBe('')
  })
})
