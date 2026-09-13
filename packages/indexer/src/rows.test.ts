import {
  defineConfig,
  initialState,
  parseAddress,
  type Auction,
  type NameRecord,
  type NnsState,
  type Obligation,
  type Offer,
  type PendingTransfer,
} from '@nimiqnames/core'
import { describe, expect, it } from 'vitest'

import { RowError, rowsOf, stateFromRows, toHeight, toLuna } from './rows.js'

// Valid addresses: the checksum is part of the format, so a made-up NQ11…
// string is rejected by `parseAddress`.
const A = 'NQ28 TKBF VF67 HP8R Y812 5FNM NNDN TS7Q F5G3' // CONSTANTS.TREASURY_ADDRESS, spaced as the RPC prints it
const B = 'NQ38 NKD4 7ALG YRDQ DXL8 PARE 7JRS JGJD MAU8' // CONSTANTS.PROTOCOL_ADDRESS
const C = 'NQ80 6XNV JDFY YEKF HMM3 UCYK VBLP 7H6Y FNXS' // CONSTANTS.ADMIN_ADDRESS
const D = 'NQ71 TPMV QN9D MV6A 1HX1 NL2Q 4CJG 5J8M QPTB' // CONSTANTS.MARKETPLACE_ADDRESS

const CONFIG = defineConfig({ networkId: 24 })

/** Real `Address` values: the brand is what keeps a raw string out of state. */
const address = (value: string) => parseAddress(value)

/**
 * A state exercising every field that has to survive a restart — including the
 * two that are easy to lose: a pending `U` whose null recipient means "release"
 * rather than "absent", and an infinite `nextDueHeight` that has no SQL
 * spelling.
 */
function populated(): NnsState {
  const base = initialState()
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
          // Non-empty on purpose: this fixture is the round-trip pin, and an
          // `evm` lost between `nameRows` and `stateFromRows` would corrupt
          // every §8.1 leaf on restart (r26).
          evm: '0x52908400098527886e0f7030069857d2e4169ee7',
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
          evm: '',
          host: '',
        },
      ],
    ]),
    transfers: new Map<string, PendingTransfer>([
      ['alice-example', { name: 'alice-example', newOwner: address(D), effectiveHeight: 58_243_200 }],
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
    // One auction with a standing bid and one without (r28, migration 010).
    // The bid ref's txIndex is 0 on purpose: a falsy value is the one a
    // `?? null` or a truthiness check would lose, and it is the commonest
    // rank a bid can have.
    auctions: new Map<string, Auction>([
      [
        'bob-in-grace',
        {
          name: 'bob-in-grace',
          seller: address(B),
          startingPrice: 50_000_000n,
          endHeight: 58_290_000,
          bidder: address(C),
          bid: 52_500_000n,
          bidRef: { height: 58_201_000, txIndex: 0 },
        },
      ],
      [
        'nns',
        {
          name: 'nns',
          seller: address(A),
          startingPrice: 400_000_000_000n,
          endHeight: 58_300_000,
          bidder: null,
          bid: 0n,
          bidRef: null,
        },
      ],
    ]),
    prices: { feeBase: 40_000_000n, commissionBp: 250n },
    pendingGovernance: {
      prices: { feeBase: 80_000_000n, commissionBp: 500n },
      effectiveHeight: 58_300_000,
    },
    lastGovernanceHeight: 58_180_000,
    unreserved: new Set(['nimiq', 'wallet']),
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
    height: state.height,
    names: [...state.names.entries()].sort(),
    transfers: [...state.transfers.entries()].sort(),
    offers: [...state.offers.entries()].sort(),
    auctions: [...state.auctions.entries()].sort(),
    prices: state.prices,
    pendingGovernance: state.pendingGovernance,
    lastGovernanceHeight: state.lastGovernanceHeight,
    unreserved: [...state.unreserved].sort(),
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
    const state = initialState()
    const restored = stateFromRows(rowsOf(state))
    expect(normalise(restored)).toEqual(normalise(state))
    expect(restored.nextDueHeight).toBe(Number.POSITIVE_INFINITY)
  })

  it('writes no UNRESERVE row, because a U is never pending (r22)', () => {
    // Through r21 a release round-tripped as a pending row with a NULL
    // recipient, and the case that mattered was that NULL is a value rather
    // than an absence. r22 made a U execute in its landing block, so the row
    // has no state to hold: a U leaves only the `unreserved` set behind, and
    // that is what `populated()` carries.
    const rows = rowsOf(populated())
    expect(rows.pending.map((row) => row.kind)).not.toContain('UNRESERVE')
    expect(rows.unreserved.sort()).toEqual(['nimiq', 'wallet'])
  })

  it('writes an AUCTION row per open auction, with the bid ref beside the committed fields', () => {
    const rows = rowsOf(populated()).pending.filter((row) => row.kind === 'AUCTION')
    expect(rows.map((row) => row.name).sort()).toEqual(['bob-in-grace', 'nns'])
    const withBid = rows.find((row) => row.name === 'bob-in-grace')
    expect(withBid).toMatchObject({
      seller: address(B),
      starting_price: '50000000',
      end_height: 58_290_000,
      bidder: address(C),
      bid: '52500000',
      bid_ref_height: 58_201_000,
      bid_ref_tx_index: 0,
    })
    const noBid = rows.find((row) => row.name === 'nns')
    expect(noBid).toMatchObject({ bidder: null, bid: '0', bid_ref_height: null, bid_ref_tx_index: null })
  })

  it('refuses an AUCTION row whose bid is half present', () => {
    // Migration 010's shape check refuses these at the table; the read
    // refuses them too, so a row that arrived any other way cannot become an
    // auction with a bid nobody can be refunded to, or a ref nobody paid.
    const rows = rowsOf(populated())
    const auction = rows.pending.find((row) => row.kind === 'AUCTION' && row.name === 'bob-in-grace')
    if (auction === undefined) throw new Error('fixture has no auction with a bid')

    const rewrite = (patch: Partial<typeof auction>) => ({
      ...rows,
      pending: rows.pending.map((row) => (row === auction ? { ...row, ...patch } : row)),
    })
    expect(() => stateFromRows(rewrite({ bidder: null }))).toThrow(RowError)
    expect(() => stateFromRows(rewrite({ bid_ref_tx_index: null }))).toThrow(RowError)
    expect(() => stateFromRows(rewrite({ bid_ref_height: null }))).toThrow(RowError)
    expect(() => stateFromRows(rewrite({ bid: null }))).toThrow(RowError)
    expect(() => stateFromRows(rewrite({ bidder: null, bid: '0', bid_ref_height: null, bid_ref_tx_index: null }))).not.toThrow()
  })

  it('keeps obligation order within one transaction', () => {
    const restored = stateFromRows(rowsOf(populated()))
    expect(restored.outstanding.get('58190001:3')?.map((item) => item.kind)).toEqual([
      'SALE_PROCEEDS',
      'COMMISSION',
    ])
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
      pending: rows.pending.map((row) => ({
        ...row,
        end_height: (row.end_height === null ? null : String(row.end_height)) as unknown as number | null,
        bid_ref_height: (row.bid_ref_height === null ? null : String(row.bid_ref_height)) as unknown as number | null,
        bid_ref_tx_index: (row.bid_ref_tx_index === null ? null : String(row.bid_ref_tx_index)) as unknown as number | null,
      })),
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
