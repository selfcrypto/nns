import { defineConfig, initialState, parseAddress, type NameRecord, type NnsState, type Obligation } from '@nimiqnames/core'
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
})
