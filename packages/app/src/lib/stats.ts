/**
 * The Stats screen's arithmetic over a `/stats` answer: which series to
 * chart, its empty buckets filled, lengths folded into §10.1's price bands,
 * verdicts sorted into §7.4's three columns. Pure, so it is tested; the
 * screen only draws what comes out.
 */

import { CONSTANTS } from '@nimiqnames/core'
import type { Stats, StatsBucket } from './api'

/** A series point: its bucket's first height and what was counted in it. */
export interface SeriesPoint {
  readonly height: number
  readonly lines: number
  readonly registrations: number
}

export interface Series {
  readonly unit: 'day' | 'hour'
  readonly points: readonly SeriesPoint[]
}

/** Fewer days than this and a daily chart is a handful of bars: the hourly window reads better. */
export const MIN_DAILY_POINTS = 7

/**
 * The activity series, every bucket from the first to the one holding
 * `stats.height` present, the quiet ones as zeros. The API sends only the
 * buckets that have lines.
 */
export function activitySeries(stats: Stats): Series {
  const { launchHeight } = stats.chain
  const { dayBlocks, hourBlocks, hourly, daily } = stats.log
  const lastDay = Math.floor((stats.height - launchHeight) / dayBlocks)
  if (lastDay + 1 >= MIN_DAILY_POINTS) {
    return { unit: 'day', points: fill(daily, 0, lastDay, dayBlocks, launchHeight) }
  }
  const lastHour = Math.floor((stats.height - launchHeight) / hourBlocks)
  const windowHours = Math.round((2 * dayBlocks) / hourBlocks)
  const firstHour = Math.max(0, lastHour - windowHours + 1)
  return { unit: 'hour', points: fill(hourly, firstHour, lastHour, hourBlocks, launchHeight) }
}

function fill(buckets: readonly StatsBucket[], first: number, last: number, size: number, launchHeight: number): SeriesPoint[] {
  const byIndex = new Map(buckets.map((bucket) => [bucket.bucket, bucket]))
  const points: SeriesPoint[] = []
  for (let index = first; index <= last; index++) {
    const bucket = byIndex.get(index)
    points.push({ height: launchHeight + index * size, lines: bucket?.lines ?? 0, registrations: bucket?.registrations ?? 0 })
  }
  return points
}

/**
 * Accepted registrations to date at the end of each point, for the growth
 * line. The hourly window starts mid-history, so it starts from what the
 * daily series says came before it.
 */
export function cumulativeRegistrations(stats: Stats, series: Series): readonly number[] {
  const total = stats.log.daily.reduce((sum, bucket) => sum + bucket.registrations, 0)
  const inWindow = series.points.reduce((sum, point) => sum + point.registrations, 0)
  let running = total - inWindow
  return series.points.map((point) => (running += point.registrations))
}

export interface BandCount {
  /** Shortest length in the band. */
  readonly from: number
  /** Longest, or `null` for the open-ended last band (§10.1's 12+). */
  readonly upTo: number | null
  readonly names: number
}

/**
 * Names per §10.1 price band, from the served per-length counts. The bands
 * are `FEE_MULTIPLIERS`', never restated; the last row is open-ended, since
 * its `upTo` is the longest a name can be rather than a price boundary.
 */
export function namesByBand(byLength: Stats['names']['byLength']): readonly BandCount[] {
  const bands = CONSTANTS.FEE_MULTIPLIERS
  return bands.map((band, index) => {
    const from = index === 0 ? 1 : (bands[index - 1]?.upTo ?? 0) + 1
    const last = index === bands.length - 1
    const names = byLength
      .filter((row) => row.length >= from && (last || row.length <= band.upTo))
      .reduce((sum, row) => sum + row.names, 0)
    return { from, upTo: last ? null : band.upTo, names }
  })
}

/** §7.4's refundable column; every other token that is not `OK` forfeited. */
const REFUND_TOKENS: ReadonlySet<string> = new Set(['LOST_REGISTRATION_RACE', 'OFFER_NOT_OPEN', 'WRONG_PRICE', 'INSUFFICIENT_VALUE'])

export type VerdictClass = 'ok' | 'refund' | 'forfeit'

export function verdictClass(verdict: string): VerdictClass {
  if (verdict === 'OK') return 'ok'
  return REFUND_TOKENS.has(verdict) ? 'refund' : 'forfeit'
}

export function verdictTotals(byVerdict: Stats['log']['byVerdict']): Record<VerdictClass, number> {
  const totals: Record<VerdictClass, number> = { ok: 0, refund: 0, forfeit: 0 }
  for (const row of byVerdict) totals[verdictClass(row.verdict)] += row.lines
  return totals
}

/** `AUCTION_TOO_LONG` → `Auction too long`: a verdict token as a line reads it. */
export function verdictText(token: string): string {
  const words = token.toLowerCase().replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A count on a small screen: `1,284`, then `12.9K`, `4.2M`. */
export function compactCount(value: number): string {
  if (value < 10_000) return value.toLocaleString('en-US')
  if (value < 1_000_000) return `${trim(value / 1_000)}K`
  return `${trim(value / 1_000_000)}M`
}

const trim = (value: number): string => (value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, ''))
