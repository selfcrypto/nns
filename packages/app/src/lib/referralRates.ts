/**
 * The published §10.7 rate table, read for display.
 *
 * One source: `packages/settlement/referral-rates.json`, the file the
 * treasury's issuer pays from. The app imports it at build time so the
 * review line ("its owner earns 10%") and the docs page can never quote a
 * rate the payer does not use. The selection rule is settlement's
 * `rateFor` restated in the browser (that module reads files, so it cannot
 * be imported here); `referralRates.test.ts` holds the two to one answer.
 */

import table from '../../../settlement/referral-rates.json'

export interface RateRow {
  readonly ref: string | null
  readonly bp: number
  /** The rate when the buyer already controls the referring name — `null`/absent means the row's own `bp` (settlement's `rates.ts`). */
  readonly selfBp?: number | null
  readonly fromHeight: number
  readonly note?: string
}

export const REFERRAL_RATES: readonly RateRow[] = (table as { rates: readonly RateRow[] }).rates

/** Basis points in effect for a referrer at a height — most specific ref first, latest height within it. `null` before any row starts. */
export function referralRateBp(name: string, height: number, rows: readonly RateRow[] = REFERRAL_RATES): number | null {
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
  return best?.bp ?? null
}

/** `1000` → `10%`; `250` → `2.5%`. */
export function percentOf(bp: number): string {
  const whole = Math.floor(bp / 100)
  const rest = bp % 100
  return rest === 0 ? `${whole}%` : `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}%`
}

/** `⌊price × bp ÷ 10,000⌋`, as settlement computes it. */
export const shareOf = (price: bigint, bp: number): bigint => (price * BigInt(bp)) / 10_000n
