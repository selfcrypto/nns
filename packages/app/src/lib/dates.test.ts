import { describe, expect, it } from 'vitest'
import { formatBubbleTimestamp, formatThreadDate } from './dates'
import { yesterdayLabel } from './wording'

// Local-time constructors, because the formatters read local calendar days.
const at = (y: number, m: number, d: number, h: number, min: number): number => new Date(y, m - 1, d, h, min).getTime()
const time = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const day = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

describe('formatThreadDate', () => {
  const now = at(2026, 9, 9, 0, 10)

  it('today is the time alone', () => {
    const ts = at(2026, 9, 9, 0, 1)
    expect(formatThreadDate(ts, now)).toBe(time(ts))
  })

  it('yesterday is a calendar day, not 24 hours: 23:50 is "Yesterday" at 00:10', () => {
    expect(formatThreadDate(at(2026, 9, 8, 23, 50), now)).toBe(yesterdayLabel())
    expect(formatThreadDate(at(2026, 9, 8, 0, 5), now)).toBe(yesterdayLabel())
  })

  it('two days back is the date', () => {
    const ts = at(2026, 9, 7, 23, 59)
    expect(formatThreadDate(ts, now)).toBe(day(ts))
  })

  it('yesterday across a month boundary', () => {
    expect(formatThreadDate(at(2026, 8, 31, 12, 0), at(2026, 9, 1, 9, 0))).toBe(yesterdayLabel())
  })
})

describe('formatBubbleTimestamp', () => {
  const now = at(2026, 9, 9, 15, 0)

  it('today is the time alone', () => {
    const ts = at(2026, 9, 9, 4, 14)
    expect(formatBubbleTimestamp(ts, now)).toBe(time(ts))
  })

  it('any other day carries the date first', () => {
    const ts = at(2026, 9, 8, 23, 59)
    expect(formatBubbleTimestamp(ts, now)).toBe(`${day(ts)}, ${time(ts)}`)
  })
})
