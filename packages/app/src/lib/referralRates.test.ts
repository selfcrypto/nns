import { describe, expect, it } from 'vitest'

import { parseRateTable, rateFor } from '../../../settlement/src/rates'
import {
  REFERRAL_RATES,
  headlineBp,
  percentOf,
  rateIsNetOfBurn,
  rebateHeadlineBp,
  referralHeadlineBp,
  referralRateBp,
  referralRebateBp,
  referralRowFor,
  shareOf,
} from './referralRates'

describe('the published table', () => {
  it('is the committed one, with a default row', () => {
    expect(REFERRAL_RATES.some((row) => row.ref === null)).toBe(true)
    expect(referralRateBp('anyone', 0)).toBe(1000)
  })

  // The straddle the table is built to survive: rows are appended, so the old
  // rate keeps applying below the new row's height and the app must quote the
  // same figure the payer used.
  it('reads the 2026-09-12 split from its height, and the old rate below it', () => {
    expect([referralRateBp('anyone', 61_411_999), referralRebateBp('anyone', 61_411_999)]).toEqual([1000, 0])
    expect([referralRateBp('anyone', 61_412_000), referralRebateBp('anyone', 61_412_000)]).toEqual([400, 400])
  })
})

describe('referralRebateBp — the buyer’s half', () => {
  it('is 0 where the row in effect states no rebate, and null only where no row is in effect', () => {
    expect(referralRebateBp('anyone', 10, [{ ref: null, bp: 1000, fromHeight: 0 }])).toBe(0)
    expect(referralRebateBp('anyone', 10, [{ ref: null, bp: 1000, rebateBp: null, fromHeight: 0 }])).toBe(0)
    expect(referralRebateBp('anyone', 10, [{ ref: null, bp: 1000, fromHeight: 100 }])).toBeNull()
  })

  it('follows the same row the share does — a partner row decides both', () => {
    const rows = [
      { ref: null, bp: 400, rebateBp: 400, fromHeight: 0 },
      { ref: 'kraken', bp: 800, rebateBp: 200, fromHeight: 0 },
    ]
    expect([referralRateBp('kraken', 0, rows), referralRebateBp('kraken', 0, rows)]).toEqual([800, 200])
    expect([referralRateBp('nobody', 0, rows), referralRebateBp('nobody', 0, rows)]).toEqual([400, 400])
    expect(referralRowFor('kraken', 0, rows)?.ref).toBe('kraken')
  })
})

describe('referralRateBp agrees with settlement’s rateFor — the payer’s rule, restated for display', () => {
  const rows = [
    { ref: null, bp: 1000, fromHeight: 0 },
    { ref: null, bp: 800, fromHeight: 500 },
    { ref: 'kraken', bp: 2500, fromHeight: 200 },
    { ref: 'kraken', bp: 2000, fromHeight: 700 },
  ]
  const settlement = parseRateTable({ rates: rows })

  it('on every (ref, height) worth asking', () => {
    for (const name of ['kraken', 'nobody']) {
      for (const height of [0, 199, 200, 499, 500, 600, 699, 700, 10_000]) {
        expect(referralRateBp(name, height, rows)).toBe(Number(rateFor(settlement, name, height)?.bp ?? -1n) === -1 ? null : Number(rateFor(settlement, name, height)?.bp))
      }
    }
  })

  // The committed rows themselves, both payouts — the display and the payer
  // must not diverge on the file they both read.
  it('and on the committed table, for both payouts', () => {
    const settlementTable = parseRateTable({ rates: REFERRAL_RATES as unknown[] })
    for (const name of ['erabexchange', 'nobody']) {
      for (const height of [0, 61_411_999, 61_412_000, 99_000_000]) {
        const row = rateFor(settlementTable, name, height)
        expect(referralRateBp(name, height)).toBe(row === null ? null : Number(row.bp))
        expect(referralRebateBp(name, height)).toBe(row === null ? null : Number(row.rebateBp ?? 0n))
      }
    }
  })

  it('is null before any row starts', () => {
    expect(referralRateBp('anyone', 10, [{ ref: null, bp: 1000, fromHeight: 100 }])).toBeNull()
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

describe('shareOf', () => {
  it('floors like settlement', () => {
    expect(shareOf(200_000_000n, 1000)).toBe(20_000_000n)
    expect(shareOf(7n, 1000)).toBe(0n)
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
  it('grosses a netOfBurn row back up and leaves every other row alone', () => {
    expect(headlineBp(400, { ref: null, bp: 400, netOfBurn: true, fromHeight: 0 })).toBe(500)
    expect(headlineBp(800, { ref: null, bp: 800, netOfBurn: true, fromHeight: 0 })).toBe(1000)
    expect(headlineBp(1000, { ref: null, bp: 1000, fromHeight: 0 })).toBe(1000)
    expect(headlineBp(1000, null)).toBe(1000)
  })

  it('states 5% and 5% from the split’s height, and 10% below it', () => {
    expect([referralHeadlineBp('anyone', 61_412_000), rebateHeadlineBp('anyone', 61_412_000)]).toEqual([500, 500])
    expect(rateIsNetOfBurn('anyone', 61_412_000)).toBe(true)
    expect([referralHeadlineBp('anyone', 61_411_999), rebateHeadlineBp('anyone', 61_411_999)]).toEqual([1000, 0])
    expect(rateIsNetOfBurn('anyone', 61_411_999)).toBe(false)
  })

  // The invariant the display change must not break: nothing that computes an
  // amount may move. `referralRateBp` is what `shareOf` is given, and the
  // issuer pays from the same rows.
  it('leaves the paid rate exactly where it was', () => {
    for (const height of [0, 61_411_999, 61_412_000, Number.MAX_SAFE_INTEGER]) {
      const row = referralRowFor('anyone', height)
      expect(referralRateBp('anyone', height)).toBe(row === null ? null : row.bp)
      expect(referralRebateBp('anyone', height)).toBe(row === null ? null : (row.rebateBp ?? 0))
    }
    expect(shareOf(40_000_000n, referralRateBp('anyone', 61_412_000) ?? 0)).toBe(1_600_000n)
  })

  it('is null before any row starts, like the rate it comes from', () => {
    expect(referralHeadlineBp('anyone', 10, [{ ref: null, bp: 400, netOfBurn: true, fromHeight: 100 }])).toBeNull()
    expect(rebateHeadlineBp('anyone', 10, [{ ref: null, bp: 400, netOfBurn: true, fromHeight: 100 }])).toBeNull()
    expect(rateIsNetOfBurn('anyone', 10, [{ ref: null, bp: 400, netOfBurn: true, fromHeight: 100 }])).toBe(false)
  })
})
