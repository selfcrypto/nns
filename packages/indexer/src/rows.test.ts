import {
  defineConfig,
  initialState,
  parseAddress,
  type NameRecord,
  type NnsState,
  type Obligation,
  type Offer,
  type PendingRecovery,
  type PendingTransfer,
  type PendingUnreserve,
} from '@nns/core'
import { describe, expect, it } from 'vitest'

import { RowError, rowsOf, stateFromRows, toHeight, toLuna } from './rows.js'

// Valid addresses: the checksum is part of the format, so a made-up NQ11…
// string is rejected by `parseAddress`.
const A = 'NQ34 248H 248H 248H 248H 248H 248H 248H 248H'
const B = 'NQ93 48H2 48H2 48H2 48H2 48H2 48H2 48H2 48H2'
const C = 'NQ60 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK'
const D = 'NQ14 8H24 8H24 8H24 8H24 8H24 8H24 8H24 8H24'

const CONFIG = defineConfig({
  networkId: 24,
  launchHeight: 58_177_000,
  treasury: A,
  protocol: B,
  admin: C,
  marketplace: D,
  listingFee: 100_000n,
})

/** Real `Address` values: the brand is what keeps a raw string out of state. */
const address = (value: string) => parseAddress(value)

/**
 * A state exercising every field that has to survive a restart — including the
 * three that are easy to lose: a null recovery on a name, a *pending* recovery
 * whose null means "clear this" rather than "absent", and an infinite
 * `nextDueHeight` that has no SQL spelling.
 */
function populated(): NnsState {
  const base = initialState(CONFIG)
  return Object.freeze({
    ...base,
    height: 58_200_000,
    names: new Map<string, NameRecord>([
      [
        'alice-example',
        {
          name: 'alice-example',
          owner: address(A),
          target: address(B),
          expiry: 215_880_000,
          status: 'REGISTERED',
          recovery: address(C),
          host: 'resolver.example.com',
        },
      ],
      [
        'bob-in-grace',
        {
          name: 'bob-in-grace',
          owner: address(B),
          target: address(B),
          expiry: 58_100_000,
          status: 'GRACE',
          recovery: null,
          host: '',
        },
      ],
    ]),
    transfers: new Map<string, PendingTransfer>([
      ['alice-example', { name: 'alice-example', newOwner: address(D), effectiveHeight: 58_243_200, viaRecovery: true }],
    ]),
    recoveries: new Map<string, PendingRecovery>([
      // recovery: null is a clearing R — not the absence of a pending R.
      ['bob-in-grace', { name: 'bob-in-grace', recovery: null, effectiveHeight: 58_250_000 }],
    ]),
    offers: new Map<string, Offer>([
      [
        'alice-example',
        {
          name: 'alice-example',
          seller: address(A),
          price: 400_000_000_000n,
          openedHeight: 58_190_000,
          expiryHeight: 59_486_000,
        },
      ],
    ]),
    prices: { feeStandard: 400_000_000n, feeLong: 40_000_000n, commissionBp: 250n },
    pendingGovernance: {
      prices: { feeStandard: 800_000_000n, feeLong: 80_000_000n, commissionBp: 500n },
      effectiveHeight: 58_300_000,
    },
    lastGovernanceHeight: 58_180_000,
    unreserved: new Set(['nimiq', 'wallet']),
    pendingUnreserve: new Map<string, PendingUnreserve>([
      // One of each: a null recipient is a release, an address an award
      // (§6 U, r17). §8.1 commits the distinction, so both must round-trip.
      ['reserved-one', { name: 'reserved-one', recipient: null, effectiveHeight: 58_260_000 }],
      ['reserved-two', { name: 'reserved-two', recipient: address(D), effectiveHeight: 58_270_000 }],
    ]),
    outstanding: new Map<string, Obligation[]>([
      [
        '58190001:3',
        [
          { ref: { height: 58_190_001, txIndex: 3 }, kind: 'SALE_PROCEEDS', owedBy: address(D), owedTo: address(A), amount: 390_000_000_000n },
          { ref: { height: 58_190_001, txIndex: 3 }, kind: 'COMMISSION', owedBy: address(D), owedTo: address(B), amount: 10_000_000_000n },
        ],
      ],
      [
        '58190002:0',
        [{ ref: { height: 58_190_002, txIndex: 0 }, kind: 'REFUND', owedBy: address(D), owedTo: address(C), amount: 12_345n }],
      ],
    ]),
    nextDueHeight: 58_243_200,
  })
}

/** Compare two states structurally, Maps and Sets included. */
function normalise(state: NnsState): unknown {
  return {
    profile: state.profile,
    height: state.height,
    names: [...state.names.entries()].sort(),
    transfers: [...state.transfers.entries()].sort(),
    recoveries: [...state.recoveries.entries()].sort(),
    offers: [...state.offers.entries()].sort(),
    prices: state.prices,
    pendingGovernance: state.pendingGovernance,
    lastGovernanceHeight: state.lastGovernanceHeight,
    unreserved: [...state.unreserved].sort(),
    pendingUnreserve: [...state.pendingUnreserve.entries()].sort(),
    outstanding: [...state.outstanding.entries()].sort(),
    nextDueHeight: state.nextDueHeight,
  }
}

describe('round trip', () => {
  it('rebuilds a populated state field for field', () => {
    const state = populated()
    expect(normalise(stateFromRows(rowsOf(state)))).toEqual(normalise(state))
  })

  it('rebuilds the empty state at LAUNCH_HEIGHT', () => {
    const state = initialState(CONFIG)
    const restored = stateFromRows(rowsOf(state))
    expect(normalise(restored)).toEqual(normalise(state))
    expect(restored.nextDueHeight).toBe(Number.POSITIVE_INFINITY)
  })

  it('keeps a pending recovery whose value is null', () => {
    // The one that a naive "NULL means no row" mapping loses: a clearing R is
    // a pending operation with a null payload, not an absent operation.
    const restored = stateFromRows(rowsOf(populated()))
    expect(restored.recoveries.get('bob-in-grace')).toEqual({
      name: 'bob-in-grace',
      recovery: null,
      effectiveHeight: 58_250_000,
    })
  })

  it('keeps obligation order within one transaction', () => {
    const restored = stateFromRows(rowsOf(populated()))
    expect(restored.outstanding.get('58190001:3')?.map((item) => item.kind)).toEqual([
      'SALE_PROCEEDS',
      'COMMISSION',
    ])
  })

  it('carries the constants profile — fast in, fast out, mainnet unmarked', () => {
    const mainnetRows = rowsOf(populated())
    expect(mainnetRows.params.profile).toBeNull()
    // Not merely undefined: no property at all, exactly as initialState
    // builds a mainnet state, so the object shape survives a restart too.
    expect('profile' in stateFromRows(mainnetRows)).toBe(false)

    const fast = Object.freeze({ ...populated(), profile: 'fast' as const })
    const rows = rowsOf(fast)
    expect(rows.params.profile).toBe('fast')
    expect(stateFromRows(rows).profile).toBe('fast')
    expect(normalise(stateFromRows(rows))).toEqual(normalise(fast))
  })

  it('rejects a profile core does not know rather than guessing its constants', () => {
    const rows = rowsOf(populated())
    const broken = { ...rows, params: { ...rows.params, profile: 'devnet' } }
    expect(() => stateFromRows(broken)).toThrow(RowError)
  })

  it('carries Infinity through as NULL and back', () => {
    const state = Object.freeze({ ...populated(), nextDueHeight: Number.POSITIVE_INFINITY })
    expect(rowsOf(state).params.next_due_height).toBeNull()
    expect(stateFromRows(rowsOf(state)).nextDueHeight).toBe(Number.POSITIVE_INFINITY)
  })

  it('survives the driver handing every number back as a string', () => {
    // What Postgres actually does with BIGINT and NUMERIC. The round trip has
    // to hold through the wire representation, not just through JS objects.
    const rows = rowsOf(populated())
    const wire = {
      ...rows,
      names: rows.names.map((row) => ({ ...row, expiry: String(row.expiry) as unknown as number })),
      params: {
        ...rows.params,
        state_height: String(rows.params.state_height) as unknown as number,
        next_due_height: String(rows.params.next_due_height) as unknown as number,
      },
    }
    expect(normalise(stateFromRows(wire))).toEqual(normalise(populated()))
  })
})

describe('scalar conversions', () => {
  it('reads a height from either representation', () => {
    expect(toHeight(58_707_600, 'x')).toBe(58_707_600)
    expect(toHeight('58707600', 'x')).toBe(58_707_600)
    expect(() => toHeight('not a number', 'x')).toThrow(RowError)
    expect(() => toHeight(1.5, 'x')).toThrow(RowError)
  })

  it('reads luna as bigint, never through a float', () => {
    expect(toLuna('400000000000', 'x')).toBe(400_000_000_000n)
    // 2^53 + 1: the first amount a Number round trip would corrupt.
    expect(toLuna('9007199254740993', 'x')).toBe(9_007_199_254_740_993n)
    expect(() => toLuna(9_007_199_254_740_993, 'x')).toThrow(RowError)
    expect(() => toLuna('1.5', 'x')).toThrow(RowError)
  })

  it('rejects a value that is not an address rather than storing it', () => {
    const rows = rowsOf(populated())
    const broken = { ...rows, names: rows.names.map((row) => ({ ...row, owner: 'NQ00 nope' })) }
    expect(() => stateFromRows(broken)).toThrow(RowError)
  })
})
