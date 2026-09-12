import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_RATES_PATH, parseRateTable, rateFor, RateTableError, readRateTable, shareAmount } from './rates.js'

const table = (rates: readonly unknown[]) => parseRateTable({ rates })

describe('parseRateTable', () => {
  it('reads the committed table, which has exactly one default row at 1,000 bp', () => {
    const committed = readRateTable(DEFAULT_RATES_PATH)
    const defaults = committed.rows.filter((row) => row.ref === null)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]?.bp).toBe(1000n)
    expect(defaults[0]?.fromHeight).toBe(0)
  })

  it('turns bp into bigint and keeps the note as text', () => {
    const parsed = table([{ ref: null, bp: 1000, fromHeight: 0, note: 'default' }])
    expect(parsed.rows[0]).toEqual({ ref: null, bp: 1000n, selfBp: null, fromHeight: 0, note: 'default' })
  })

  // A row written before the field existed says nothing about the case, and
  // saying nothing has to keep meaning what it meant — otherwise adding the
  // field would silently restate every published rate.
  it('selfBp is optional, and absent is null rather than zero', () => {
    expect(table([{ ref: null, bp: 1000, fromHeight: 0 }]).rows[0]?.selfBp).toBeNull()
    expect(table([{ ref: null, bp: 1000, selfBp: 0, fromHeight: 0 }]).rows[0]?.selfBp).toBe(0n)
    expect(table([{ ref: null, bp: 1000, selfBp: 500, fromHeight: 0 }]).rows[0]?.selfBp).toBe(500n)
    expect(table([{ ref: null, bp: 1000, selfBp: null, fromHeight: 0 }]).rows[0]?.selfBp).toBeNull()
  })

  it('refuses a selfBp that is not basis points', () => {
    expect(() => table([{ ref: null, bp: 1000, selfBp: -1, fromHeight: 0 }])).toThrow(/selfBp/)
    expect(() => table([{ ref: null, bp: 1000, selfBp: 10_001, fromHeight: 0 }])).toThrow(/selfBp/)
    expect(() => table([{ ref: null, bp: 1000, selfBp: '0', fromHeight: 0 }])).toThrow(/selfBp/)
  })

  it('refuses a table with no default row — an unlisted name would have no rate', () => {
    expect(() => table([{ ref: 'kraken', bp: 2500, fromHeight: 0 }])).toThrow(/no default row/)
  })

  it('refuses a ref that is not a §4.1 name — a ref is a registered name', () => {
    expect(() => table([{ ref: null, bp: 1000, fromHeight: 0 }, { ref: 'Kraken', bp: 2500, fromHeight: 0 }])).toThrow(/not a valid §4.1 name/)
    expect(() => table([{ ref: null, bp: 1000, fromHeight: 0 }, { ref: '-kraken', bp: 2500, fromHeight: 0 }])).toThrow(/not a valid §4.1 name/)
  })

  it('refuses bp outside 0…10,000, fractions, and negative heights', () => {
    expect(() => table([{ ref: null, bp: 10_001, fromHeight: 0 }])).toThrow(/between 0 and 10000/)
    expect(() => table([{ ref: null, bp: 12.5, fromHeight: 0 }])).toThrow(/between 0 and 10000/)
    expect(() => table([{ ref: null, bp: 1000, fromHeight: -1 }])).toThrow(/non-negative integer height/)
  })

  it('refuses two rows for one ref at one height — a change is appended at a later height', () => {
    expect(() =>
      table([
        { ref: null, bp: 1000, fromHeight: 0 },
        { ref: 'kraken', bp: 2500, fromHeight: 100 },
        { ref: 'kraken', bp: 3000, fromHeight: 100 },
      ]),
    ).toThrow(/two rows for kraken from height 100/)
  })

  it('refuses a document that is not a table', () => {
    expect(() => parseRateTable([])).toThrow(RateTableError)
    expect(() => parseRateTable({ rates: 'no' })).toThrow(/`rates` array/)
    expect(() => table(['row'])).toThrow(/not an object/)
  })
})

describe('readRateTable', () => {
  it('names the path when the file is missing or not JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nns-rates-'))
    expect(() => readRateTable(join(dir, 'missing.json'))).toThrow(/cannot read the rate table at .*missing\.json/)
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{ not json')
    expect(() => readRateTable(bad)).toThrow(/is not JSON/)
  })
})

describe('rateFor', () => {
  const rows = table([
    { ref: null, bp: 1000, fromHeight: 0 },
    { ref: null, bp: 800, fromHeight: 500 },
    { ref: 'kraken', bp: 2500, fromHeight: 200 },
    { ref: 'kraken', bp: 2000, fromHeight: 700 },
  ])

  it('gives an unlisted name the default row in effect at the height', () => {
    expect(rateFor(rows, 'nobody', 499)?.bp).toBe(1000n)
    expect(rateFor(rows, 'nobody', 500)?.bp).toBe(800n)
  })

  it('an exact ref beats the default whatever their heights, and the latest row of that ref wins', () => {
    expect(rateFor(rows, 'kraken', 199)?.bp).toBe(1000n) // its own row has not started
    expect(rateFor(rows, 'kraken', 200)?.bp).toBe(2500n)
    expect(rateFor(rows, 'kraken', 600)?.bp).toBe(2500n) // the later default does not displace an earlier exact row
    expect(rateFor(rows, 'kraken', 700)?.bp).toBe(2000n)
  })

  it('is null before any row has started', () => {
    const late = table([{ ref: null, bp: 1000, fromHeight: 1_000 }])
    expect(rateFor(late, 'anyone', 999)).toBeNull()
    expect(rateFor(late, 'anyone', 1_000)?.bp).toBe(1000n)
  })
})

describe('shareAmount', () => {
  it('floors price × bp ÷ 10,000', () => {
    expect(shareAmount(200_000_000n, 1000n)).toBe(20_000_000n) // 10% of 2,000 NIM
    expect(shareAmount(7n, 1000n)).toBe(0n) // 0.7 luna floors to nothing
    expect(shareAmount(40_000_000n, 2500n)).toBe(10_000_000n)
  })
})
