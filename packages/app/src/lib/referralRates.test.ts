import { describe, expect, it } from 'vitest'

import { parseRateTable, rateFor } from '../../../settlement/src/rates'
import { REFERRAL_RATES, percentOf, referralRateBp, shareOf } from './referralRates'

describe('the published table', () => {
  it('is the committed one, with a default row', () => {
    expect(REFERRAL_RATES.some((row) => row.ref === null)).toBe(true)
    expect(referralRateBp('anyone', 0)).toBe(1000)
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
