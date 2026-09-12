/**
 * The published §10.7 rate table, read for display.
 *
 * One source and one rule: `packages/settlement/referral-rates.json`, the file
 * the treasury's issuer pays from, parsed and selected by settlement's own
 * `rate-table.ts` — imported by path, because that module is pure (the file
 * half is `rates.ts`, which the browser cannot load) and because a package
 * dependency on `@nns/settlement` would drag `pg` into the web image's
 * install. So the review line ("5% comes back to you") and the docs page can
 * never quote a rate the payer does not use, and nothing here restates how a
 * row is chosen.
 *
 * A row prices **two** payouts: `bp` to the referrer and `rebateBp` back to
 * the buyer. On a row marked `netOfBurn` both are stated with the §10.2 burn
 * already taken out — 400 bp — because the payer must not burn on money it
 * never kept. The **app states the rate it came from**: 5%, with the burn
 * named beside it. `headlineBp` is that one conversion, and it lives here so
 * no screen invents it. Anything that computes an amount keeps the paid rate
 * (`referralRateBp`, `shareAmount`).
 */

import { CONSTANTS } from '@nns/core'

import table from '../../../settlement/referral-rates.json'
import { parseRateTable, rateFor, rebateRowFor, type RateRow, type RateTable } from '../../../settlement/src/rate-table'

export { parseRateTable, shareAmount, type RateRow, type RateTable } from '../../../settlement/src/rate-table'

/** The committed table. A malformed file fails the build, as it fails the issuer's startup. */
export const REFERRAL_RATES: RateTable = parseRateTable(table)

/** The rate the payer **sends** to the referrer, in basis points — `null` before any row starts. */
export const referralRateBp = (name: string, height: number, rates: RateTable = REFERRAL_RATES): bigint | null =>
  rateFor(rates, name, height)?.bp ?? null

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
export function headlineBp(bp: bigint, row: RateRow | null): number {
  if (row === null || !row.netOfBurn) return Number(bp)
  const burn = Number(CONSTANTS.BURN_SHARE_BP)
  return Math.round((Number(bp) * 10_000) / (10_000 - burn))
}

/** The referrer's share as the app states it — `null` before any row starts. */
export function referralHeadlineBp(name: string, height: number, rates: RateTable = REFERRAL_RATES): number | null {
  const row = rateFor(rates, name, height)
  return row === null ? null : headlineBp(row.bp, row)
}

/** The buyer's rebate as the app states it — `0` where no row pays one, `null` before any row starts. */
export function rebateHeadlineBp(name: string, height: number, rates: RateTable = REFERRAL_RATES): number | null {
  if (rateFor(rates, name, height) === null) return null
  const row = rebateRowFor(rates, name, height)
  return row === null ? 0 : headlineBp(row.rebateBp ?? 0n, row)
}

/**
 * Whether the rates shown for this referrer have the burn to come out of them
 * — the sentence beside the number depends on it. Both rows must agree: the
 * share's and the rebate's can differ once a partner row falls back, and one
 * aside covering two rates has to be true of both.
 */
export function rateIsNetOfBurn(name: string, height: number, rates: RateTable = REFERRAL_RATES): boolean {
  if (rateFor(rates, name, height)?.netOfBurn !== true) return false
  const rebate = rebateRowFor(rates, name, height)
  return rebate === null || (rebate.rebateBp ?? 0n) === 0n || rebate.netOfBurn
}

/** `1000` → `10%`; `250` → `2.5%`. */
export function percentOf(bp: number): string {
  const whole = Math.floor(bp / 100)
  const rest = bp % 100
  return rest === 0 ? `${whole}%` : `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}%`
}

/** The rebate to quote to a buyer — the headline, as a percentage — or `null` where the row in effect pays none. */
export function rebatePercent(name: string, height: number, rates: RateTable = REFERRAL_RATES): string | null {
  const bp = rebateHeadlineBp(name, height, rates) ?? 0
  return bp > 0 ? percentOf(bp) : null
}
