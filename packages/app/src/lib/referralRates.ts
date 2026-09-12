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
 * the buyer. On a row marked `netOfBurn` both are stated with the §10.2 burn
 * already taken out — 400 bp — because the payer must not burn on money it
 * never kept (settlement's `rates.ts`). The **app states the rate it came
 * from**: 5%, with the burn named beside it. `headlineBp` is that one
 * conversion, and it lives here so no screen invents it.
 */

import { CONSTANTS } from '@nns/core'

import table from '../../../settlement/referral-rates.json'

export interface RateRow {
  readonly ref: string | null
  /** The referrer's share. */
  readonly bp: number
  /** The buyer's rebate — `null`/absent is **no rebate**, never a fallback to `bp` (settlement's `rates.ts`). */
  readonly rebateBp?: number | null
  /** The rate for both payouts when the buyer already controls the referring name — `null`/absent means each payout's own rate. */
  readonly selfBp?: number | null
  /** This row's rates already have the §10.2 burn out of them, so the app states the headline they came from. Absent is "as published". */
  readonly netOfBurn?: boolean
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
 * The row the **rebate** comes from: the referrer's own where it states one,
 * otherwise the default row in effect. The rebate is the buyer's, not the
 * referrer's (Kike, 2026-09-12: "any user using a referral gets a fixed 5%,
 * always, no matter the % we set for a certain referral"), so a partner row
 * that raises a share does not take the buyer's half away by not restating
 * it. Settlement's `rebateFor` is the same rule, and pays from it.
 */
export function rebateRowFor(name: string, height: number, rows: readonly RateRow[] = REFERRAL_RATES): RateRow | null {
  const own = referralRowFor(name, height, rows)
  if (own !== null && own.rebateBp !== null && own.rebateBp !== undefined) return own
  return referralRowFor('', height, rows)
}

/**
 * The buyer's rebate in basis points: `0` where no row in effect states one,
 * `null` only when no row is in effect at all — the same two answers the
 * share gives, so a caller never has to tell "no table" from "no rebate".
 */
export function referralRebateBp(name: string, height: number, rows: readonly RateRow[] = REFERRAL_RATES): number | null {
  if (referralRowFor(name, height, rows) === null) return null
  const row = rebateRowFor(name, height, rows)
  return row === null ? 0 : (row.rebateBp ?? 0)
}

/**
 * The rate a row states, before the §10.2 burn: `400` → `500`, so the app can
 * say 5% where the payer holds 400 bp. A row that is not `netOfBurn` is
 * already its own headline and comes back unchanged — the pre-2026-09-12
 * default paid its 10% flat, and grossing it up would invent a rate nobody
 * published.
 *
 * The burn share is a protocol constant, not a number retyped here: a
 * governance change to it moves both the payout and this line together.
 */
export function headlineBp(bp: number, row: RateRow | null): number {
  if (row === null || row.netOfBurn !== true) return bp
  const burn = Number(CONSTANTS.BURN_SHARE_BP)
  return Math.round((bp * 10_000) / (10_000 - burn))
}

/** The referrer's share as the app states it — `null` before any row starts. */
export function referralHeadlineBp(name: string, height: number, rows: readonly RateRow[] = REFERRAL_RATES): number | null {
  const row = referralRowFor(name, height, rows)
  return row === null ? null : headlineBp(row.bp, row)
}

/** The buyer's rebate as the app states it — `0` where no row pays one, `null` before any row starts. */
export function rebateHeadlineBp(name: string, height: number, rows: readonly RateRow[] = REFERRAL_RATES): number | null {
  if (referralRowFor(name, height, rows) === null) return null
  const row = rebateRowFor(name, height, rows)
  return row === null ? 0 : headlineBp(row.rebateBp ?? 0, row)
}

/**
 * Whether the rates shown for this referrer have the burn to come out of them
 * — the sentence beside the number depends on it. Both rows must agree: the
 * share's and the rebate's can differ once a partner row falls back, and one
 * aside covering two rates has to be true of both.
 */
export function rateIsNetOfBurn(name: string, height: number, rows: readonly RateRow[] = REFERRAL_RATES): boolean {
  const share = referralRowFor(name, height, rows)
  if (share?.netOfBurn !== true) return false
  const rebate = rebateRowFor(name, height, rows)
  return rebate === null || (rebate.rebateBp ?? 0) === 0 || rebate.netOfBurn === true
}

/** `1000` → `10%`; `250` → `2.5%`. */
export function percentOf(bp: number): string {
  const whole = Math.floor(bp / 100)
  const rest = bp % 100
  return rest === 0 ? `${whole}%` : `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}%`
}

/** `⌊price × bp ÷ 10,000⌋`, as settlement computes it. */
export const shareOf = (price: bigint, bp: number): bigint => (price * BigInt(bp)) / 10_000n
