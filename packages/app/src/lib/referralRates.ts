/**
 * The published §10.7 rate table, read for display.
 *
 * One source: `packages/settlement/referral-rates.json`, the file the
 * treasury's issuer pays from. The app imports it at build time so the
 * review line ("its owner earns 5%") and the docs page can never quote a
 * rate the payer does not use. The selection rule is settlement's
 * `rateFor` restated in the browser (that module reads files, so it cannot
 * be imported here); `referralRates.test.ts` holds the two to one answer.
 *
 * A row prices **two** payouts: `bp` to the referrer and `rebateBp` back to
 * the buyer. Both are published net of the §10.2 burn, which is why a
 * headline 5% reads 400 bp here — see settlement's `rates.ts` for why the
 * table carries the net figure rather than computing it.
 */

import table from '../../../settlement/referral-rates.json'

export interface RateRow {
  readonly ref: string | null
  /** The referrer's share. */
  readonly bp: number
  /** The buyer's rebate — `null`/absent is **no rebate**, never a fallback to `bp` (settlement's `rates.ts`). */
  readonly rebateBp?: number | null
  /** The rate for both payouts when the buyer already controls the referring name — `null`/absent means each payout's own rate. */
  readonly selfBp?: number | null
  readonly fromHeight: number
  readonly note?: string
}

export const REFERRAL_RATES: readonly RateRow[] = (table as { rates: readonly RateRow[] }).rates

/** The row in effect for a referrer at a height — most specific ref first, latest height within it. `null` before any row starts. */
export function referralRowFor(name: string, height: number, rows: readonly RateRow[] = REFERRAL_RATES): RateRow | null {
  let best: RateRow | null = null
  for (const row of rows) {
    if (row.fromHeight > height) continue
    if (row.ref !== null && row.ref !== name) continue
    if (best === null) {
      best = row
      continue
    }
    const moreSpecific = row.ref !== null && best.ref === null
    const later = (row.ref === null) === (best.ref === null) && row.fromHeight > best.fromHeight
    if (moreSpecific || later) best = row
  }
  return best
}

/** The referrer's share in basis points, or `null` before any row starts. */
export const referralRateBp = (name: string, height: number, rows: readonly RateRow[] = REFERRAL_RATES): number | null =>
  referralRowFor(name, height, rows)?.bp ?? null

/**
 * The buyer's rebate in basis points: `0` where the row in effect states none,
 * `null` only when no row is in effect at all — the same two answers the
 * share gives, so a caller never has to tell "no table" from "no rebate".
 */
export function referralRebateBp(name: string, height: number, rows: readonly RateRow[] = REFERRAL_RATES): number | null {
  const row = referralRowFor(name, height, rows)
  return row === null ? null : (row.rebateBp ?? 0)
}

/** `1000` → `10%`; `250` → `2.5%`. */
export function percentOf(bp: number): string {
  const whole = Math.floor(bp / 100)
  const rest = bp % 100
  return rest === 0 ? `${whole}%` : `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}%`
}

/** `⌊price × bp ÷ 10,000⌋`, as settlement computes it. */
export const shareOf = (price: bigint, bp: number): bigint => (price * BigInt(bp)) / 10_000n
