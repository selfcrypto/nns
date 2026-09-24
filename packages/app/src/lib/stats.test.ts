import { describe, expect, it } from 'vitest'
import type { Stats } from './api'
import { activitySeries, compactCount, cumulativeRegistrations, MIN_DAILY_POINTS, namesByBand, verdictClass, verdictText, verdictTotals } from './stats'

const LAUNCH = 1_000_000

function statsAt(height: number, log: Partial<Stats['log']> = {}): Stats {
  return {
    chain: { launchHeight: LAUNCH, scannedThrough: height, checkpointInterval: 60 },
    log: { lines: 0, senders: 0, byType: [], byVerdict: [], daily: [], hourly: [], dayBlocks: 86_400, hourBlocks: 3_600, ...log },
    height,
  } as unknown as Stats
}

describe('activitySeries', () => {
  it('charts the last 48 hours while the registry is younger than a week, quiet hours as zeros', () => {
    const height = LAUNCH + 3 * 86_400 + 10
    const lastHour = Math.floor((height - LAUNCH) / 3_600)
    const series = activitySeries(statsAt(height, { hourly: [{ bucket: lastHour, lines: 5, registrations: 2 }] }))
    expect(series.unit).toBe('hour')
    expect(series.points).toHaveLength(48)
    expect(series.points.at(-1)).toEqual({ height: LAUNCH + lastHour * 3_600, lines: 5, registrations: 2 })
    expect(series.points[0]?.lines).toBe(0)
  })

  it('starts the hourly window at launch when fewer than 48 hours have passed', () => {
    const series = activitySeries(statsAt(LAUNCH + 5 * 3_600))
    expect(series.points).toHaveLength(6)
    expect(series.points[0]?.height).toBe(LAUNCH)
  })

  it('switches to days once there are enough of them', () => {
    const height = LAUNCH + (MIN_DAILY_POINTS - 1) * 86_400
    const series = activitySeries(statsAt(height, { daily: [{ bucket: 2, lines: 9, registrations: 4 }] }))
    expect(series.unit).toBe('day')
    expect(series.points).toHaveLength(MIN_DAILY_POINTS)
    expect(series.points[2]).toEqual({ height: LAUNCH + 2 * 86_400, lines: 9, registrations: 4 })
  })
})

describe('cumulativeRegistrations', () => {
  it('starts the hourly window from what came before it', () => {
    const height = LAUNCH + 3 * 86_400
    const lastHour = Math.floor((height - LAUNCH) / 3_600)
    const stats = statsAt(height, {
      daily: [{ bucket: 0, lines: 10, registrations: 10 }, { bucket: 3, lines: 3, registrations: 3 }],
      hourly: [{ bucket: lastHour, lines: 3, registrations: 3 }],
    })
    const running = cumulativeRegistrations(stats, activitySeries(stats))
    expect(running[0]).toBe(10)
    expect(running.at(-1)).toBe(13)
  })
})

describe('namesByBand', () => {
  it('folds lengths into the seven price bands, the last one open-ended', () => {
    const bands = namesByBand([
      { length: 3, names: 1 },
      { length: 7, names: 2 },
      { length: 11, names: 3 },
      { length: 12, names: 4 },
      { length: 30, names: 5 },
    ])
    expect(bands).toHaveLength(7)
    expect(bands[0]).toEqual({ from: 1, upTo: 2, names: 0 })
    expect(bands[1]).toEqual({ from: 3, upTo: 3, names: 1 })
    expect(bands[5]).toEqual({ from: 7, upTo: 11, names: 5 })
    expect(bands[6]).toEqual({ from: 12, upTo: null, names: 9 })
  })
})

describe('verdicts', () => {
  it('sorts tokens into the three §7.4 columns', () => {
    expect(verdictClass('OK')).toBe('ok')
    expect(verdictClass('WRONG_PRICE')).toBe('refund')
    expect(verdictClass('AUCTION_TOO_LONG')).toBe('forfeit')
    expect(
      verdictTotals([
        { verdict: 'OK', lines: 5 },
        { verdict: 'INSUFFICIENT_VALUE', lines: 2 },
        { verdict: 'NOT_OWNER', lines: 1 },
      ]),
    ).toEqual({ ok: 5, refund: 2, forfeit: 1 })
  })

  it('reads a token as words', () => {
    expect(verdictText('AUCTION_TOO_LONG')).toBe('Auction too long')
  })
})

describe('compactCount', () => {
  it('groups small counts and compacts large ones', () => {
    expect(compactCount(1_284)).toBe('1,284')
    expect(compactCount(12_900)).toBe('12.9K')
    expect(compactCount(250_000)).toBe('250K')
    expect(compactCount(4_200_000)).toBe('4.2M')
  })
})
