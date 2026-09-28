import { defineConfig, initialState, parseAddress, type Auction, type NameRecord, type NnsState, type Obligation, type Offer } from '@nimiqnames/core'
import { describe, expect, it } from 'vitest'

import { diffState } from './diff.js'

const A = 'NQ39 M3TJ 2NC1 G4PJ 07JF BFKG Q3X6 AK7K J7YT' // CONSTANTS.TREASURY_ADDRESS, spaced as the RPC prints it
const B = 'NQ91 SQRC L91X D5QK 6A21 1UV7 11EY 7YA3 BBRT' // CONSTANTS.PROTOCOL_ADDRESS
const C = 'NQ95 0MNS X5BJ 3SMV XA2E 7059 BU9F AXX6 J4MX' // CONSTANTS.ADMIN_ADDRESS
const D = 'NQ55 SY33 7HS4 DP5N H9P0 9PMG 7MD8 PTL8 N2P5' // CONSTANTS.MARKETPLACE_ADDRESS

const CONFIG = defineConfig({ networkId: 24 })

const compact = (value: string) => parseAddress(value)

function withName(state: NnsState, name: string, overrides: Record<string, unknown> = {}): NnsState {
  const names = new Map<string, NameRecord>(state.names)
  names.set(name, {
    name,
    owner: compact(A),
    target: compact(A),
    expiry: 215_000_000,
    status: 'REGISTERED',
    evm: '',
    host: '',
    ...overrides,
  } as NameRecord)
  return Object.freeze({ ...state, names })
}

describe('diffState', () => {
  it('treats a null `before` as an all-insert', () => {
    const after = withName(initialState(), 'alice-example')
    const diff = diffState(null, after)
    expect(diff.names.upsert.map((row) => row.name)).toEqual(['alice-example'])
    expect(diff.names.remove).toEqual([])
    expect(diff.hasRowChanges).toBe(true)
  })

  it('writes nothing but params when only the height moved', () => {
    // The common case by far: 720 batches a day, almost all of them empty.
    const before = withName(initialState(), 'alice-example')
    const after = Object.freeze({ ...before, height: before.height + 60 })
    const diff = diffState(before, after)
    expect(diff.hasRowChanges).toBe(false)
    expect(diff.params.state_height).toBe(after.height)
  })

  it('upserts only the name that changed', () => {
    const before = withName(withName(initialState(), 'alice-example'), 'bob-example')
    const after = withName(before, 'bob-example', { status: 'GRACE' })
    const diff = diffState(before, after)
    expect(diff.names.upsert.map((row) => row.name)).toEqual(['bob-example'])
    expect(diff.names.remove).toEqual([])
  })

  it('removes a name that left the state', () => {
    const before = withName(initialState(), 'alice-example')
    const names = new Map(before.names)
    names.delete('alice-example')
    const after = Object.freeze({ ...before, names })
    expect(diffState(before, after).names.remove).toEqual(['alice-example'])
  })

  it('replaces a transaction’s obligations as a group', () => {
    // Their order within one transaction is significant, so a partial update
    // would have to reason about ordinals. Delete-then-insert cannot.
    const before = initialState()
    const after = Object.freeze({
      ...before,
      outstanding: new Map<string, Obligation[]>([
        [
          '58190001:3',
          [
            { ref: { height: 58_190_001, txIndex: 3 }, kind: 'SALE_PROCEEDS', owedBy: compact(D), owedTo: compact(A), amount: 100n },
            { ref: { height: 58_190_001, txIndex: 3 }, kind: 'COMMISSION', owedBy: compact(D), owedTo: compact(B), amount: 5n },
          ],
        ],
      ]),
    })
    const diff = diffState(before, after)
    expect(diff.settlements.remove).toEqual([{ height: 58_190_001, txIndex: 3 }])
    expect(diff.settlements.upsert.map((row) => row.ordinal)).toEqual([0, 1])
  })

  it('removes settled obligations', () => {
    const withDebt = Object.freeze({
      ...initialState(),
      outstanding: new Map<string, Obligation[]>([
        ['58190001:3', [{ ref: { height: 58_190_001, txIndex: 3 }, kind: 'REFUND', owedBy: compact(D), owedTo: compact(A), amount: 100n }]],
      ]),
    })
    const diff = diffState(withDebt, initialState())
    expect(diff.settlements.remove).toEqual([{ height: 58_190_001, txIndex: 3 }])
    expect(diff.settlements.upsert).toEqual([])
  })

  it('tracks names entering and leaving the unreserved set', () => {
    const before = initialState()
    const after = Object.freeze({ ...before, unreserved: new Set(['nimiq']) })
    expect(diffState(before, after).unreserved).toEqual({ add: ['nimiq'], remove: [] })
    expect(diffState(after, before).unreserved).toEqual({ add: [], remove: ['nimiq'] })
  })

  describe('pending', () => {
    const withAuction = (state: NnsState, auction: Partial<Auction> = {}): NnsState =>
      Object.freeze({
        ...state,
        auctions: new Map<string, Auction>([
          [
            'alice-example',
            { name: 'alice-example', seller: compact(A), startingPrice: 100n, endHeight: 215_000_000, bidder: null, bid: 0n, bidRef: null, ...auction },
          ],
        ]),
      })
    const open = withAuction(withName(initialState(), 'alice-example'))

    it('writes an opened auction once, and nothing while it stands untouched', () => {
      const opened = diffState(withName(initialState(), 'alice-example'), open)
      expect(opened.pending.upsert.map((row) => [row.kind, row.name, row.bidder, row.bid])).toEqual([['AUCTION', 'alice-example', null, '0']])
      expect(opened.pending.remove).toEqual([])
      const later = diffState(open, Object.freeze({ ...open, height: open.height + 60 }))
      expect(later.pending).toEqual({ upsert: [], remove: [] })
      expect(later.hasRowChanges).toBe(false)
    })

    // The close owes its two legs by the standing bid's ref, so a bid that
    // did not reach the row would survive a restart as a debt to the wrong
    // transaction.
    it('writes the row again when a bid lands, and again when it is outbid', () => {
      const first = withAuction(open, { bidder: compact(B), bid: 100n, bidRef: { height: 58_190_001, txIndex: 3 } })
      const bid = diffState(open, first).pending
      expect(bid.remove).toEqual([])
      expect(bid.upsert).toHaveLength(1)
      expect(bid.upsert[0]).toMatchObject({ kind: 'AUCTION', bidder: compact(B), bid: '100', bid_ref_height: 58_190_001, bid_ref_tx_index: 3 })

      const second = withAuction(first, { bidder: compact(C), bid: 105n, bidRef: { height: 58_190_002, txIndex: 0 } })
      const outbid = diffState(first, second).pending
      expect(outbid.upsert).toHaveLength(1)
      expect(outbid.upsert[0]).toMatchObject({ bidder: compact(C), bid: '105', bid_ref_height: 58_190_002, bid_ref_tx_index: 0 })
    })

    it('writes the row again when a late bid moves the end', () => {
      const extended = diffState(open, withAuction(open, { endHeight: 215_000_600 })).pending
      expect(extended.upsert.map((row) => row.end_height)).toEqual([215_000_600])
    })

    it('removes the row when the auction closes', () => {
      const closed = Object.freeze({ ...open, auctions: new Map<string, Auction>() })
      const diff = diffState(open, closed)
      expect(diff.pending).toEqual({ upsert: [], remove: [{ kind: 'AUCTION', name: 'alice-example' }] })
      expect(diff.hasRowChanges).toBe(true)
    })

    it('keys a row by kind and name, so a sale ending as an auction opens is one removal and one write', () => {
      const listed = Object.freeze({
        ...withName(initialState(), 'alice-example'),
        offers: new Map<string, Offer>([
          ['alice-example', { name: 'alice-example', seller: compact(A), price: 100n, openedHeight: 58_190_000, expiryHeight: 215_000_000 }],
        ]),
      })
      const diff = diffState(listed, open).pending
      expect(diff.remove).toEqual([{ kind: 'OFFER', name: 'alice-example' }])
      expect(diff.upsert.map((row) => row.kind)).toEqual(['AUCTION'])
    })
  })
})
