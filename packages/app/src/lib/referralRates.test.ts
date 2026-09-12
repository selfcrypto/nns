import { describe, expect, it } from 'vitest'

import {
  headlineBp,
  parseRateTable,
  percentOf,
  rateIsNetOfBurn,
  rebateHeadlineBp,
  rebatePercent,
  REFERRAL_RATES,
  referralHeadlineBp,
  referralRateBp,
  shareAmount,
} from './referralRates'

const rates = (rows: readonly unknown[]) => parseRateTable({ rates: rows })

describe('the published table', () => {
  it('is the committed one, parsed by the rule the payer runs', () => {
    expect(REFERRAL_RATES.rows.some((row) => row.ref === null)).toBe(true)
    expect(referralRateBp('anyone', 0)).toBe(1000n)
  })

  // The straddle the table is built to survive: rows are appended, so the old
  // rate keeps applying below the new row's height and the app must quote the
  // same figure the payer used.
  it('reads the 2026-09-12 split from its height, and the old rate below it', () => {
    expect([referralRateBp('anyone', 61_411_999), rebateHeadlineBp('anyone', 61_411_999)]).toEqual([1000n, 0])
    expect([referralRateBp('anyone', 61_412_000), rebateHeadlineBp('anyone', 61_412_000)]).toEqual([400n, 500])
  })

  it('is null before any row starts', () => {
    expect(referralRateBp('anyone', 10, rates([{ ref: null, bp: 1000, fromHeight: 100 }]))).toBeNull()
  })
})

describe('the buyer’s half', () => {
  it('is 0 where the row in effect states no rebate, and null only where no row is in effect', () => {
    expect(rebateHeadlineBp('anyone', 10, rates([{ ref: null, bp: 1000, fromHeight: 0 }]))).toBe(0)
    expect(rebateHeadlineBp('anyone', 10, rates([{ ref: null, bp: 1000, rebateBp: null, fromHeight: 0 }]))).toBe(0)
    expect(rebateHeadlineBp('anyone', 10, rates([{ ref: null, bp: 1000, fromHeight: 100 }]))).toBeNull()
  })

  it('comes from the partner row when it states one, and the default when it does not', () => {
    const table = rates([
      { ref: null, bp: 400, rebateBp: 400, fromHeight: 0 },
      { ref: 'kraken', bp: 800, rebateBp: 200, fromHeight: 0 },
      { ref: 'quiet', bp: 800, fromHeight: 0 },
    ])
    expect([referralRateBp('kraken', 0, table), rebateHeadlineBp('kraken', 0, table)]).toEqual([800n, 200])
    expect([referralRateBp('quiet', 0, table), rebateHeadlineBp('quiet', 0, table)]).toEqual([800n, 400])
    expect([referralRateBp('nobody', 0, table), rebateHeadlineBp('nobody', 0, table)]).toEqual([400n, 400])
  })

  it('is a sentence-ready percentage, or null where there is nothing to say', () => {
    expect(rebatePercent('anyone', 61_412_000)).toBe('5%')
    expect(rebatePercent('anyone', 61_411_999)).toBeNull()
    expect(rebatePercent('anyone', 10, rates([{ ref: null, bp: 1000, fromHeight: 100 }]))).toBeNull()
  })
})

describe('percentOf', () => {
  it('renders basis points as a percentage without trailing zeros', () => {
    expect(percentOf(1000)).toBe('10%')
    expect(percentOf(250)).toBe('2.5%')
    expect(percentOf(1)).toBe('0.01%')
    expect(percentOf(10_000)).toBe('100%')
  })
})

/**
 * The rate the programme publishes and the rate the payer sends are two
 * numbers, and the app owes each of them to a different reader: 5% to
 * anybody reading what a referral is worth, 400 bp to anything counting NIM.
 * Mixing them up overstates an estimate by a quarter, so the split is tested
 * from both ends.
 */
describe('the headline rate', () => {
  const row = (bp: number, netOfBurn: boolean) => rates([{ ref: null, bp, netOfBurn, fromHeight: 0 }]).rows[0]!

  it('grosses a netOfBurn row back up and leaves every other row alone', () => {
    expect(headlineBp(400n, row(400, true))).toBe(500)
    expect(headlineBp(800n, row(800, true))).toBe(1000)
    expect(headlineBp(1000n, row(1000, false))).toBe(1000)
    expect(headlineBp(1000n, null)).toBe(1000)
  })

  it('states 5% and 5% from the split’s height, and 10% below it', () => {
    expect([referralHeadlineBp('anyone', 61_412_000), rebateHeadlineBp('anyone', 61_412_000)]).toEqual([500, 500])
    expect(rateIsNetOfBurn('anyone', 61_412_000)).toBe(true)
    expect([referralHeadlineBp('anyone', 61_411_999), rebateHeadlineBp('anyone', 61_411_999)]).toEqual([1000, 0])
    expect(rateIsNetOfBurn('anyone', 61_411_999)).toBe(false)
  })

  // The invariant the display change must not break: nothing that computes an
  // amount may move. `referralRateBp` is what `shareAmount` is given, and the
  // issuer pays from the same rows.
  it('leaves the paid rate exactly where it was', () => {
    expect(shareAmount(40_000_000n, referralRateBp('anyone', 61_412_000) ?? 0n)).toBe(1_600_000n)
    expect(shareAmount(40_000_000n, referralRateBp('anyone', 61_411_999) ?? 0n)).toBe(4_000_000n)
  })

  it('is null before any row starts, like the rate it comes from', () => {
    const late = rates([{ ref: null, bp: 400, netOfBurn: true, fromHeight: 100 }])
    expect(referralHeadlineBp('anyone', 10, late)).toBeNull()
    expect(rebateHeadlineBp('anyone', 10, late)).toBeNull()
    expect(rateIsNetOfBurn('anyone', 10, late)).toBe(false)
  })
})
