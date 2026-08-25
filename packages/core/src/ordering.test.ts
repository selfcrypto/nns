import { describe, expect, it } from 'vitest'
import { OrderingError, rankMessages, type OrderInput } from './ordering.js'

/** `NNS1G…` as hex — enough to be in the §5.2 universe. */
const NNS = '4e4e5331476b696b656e616d65'

const hash = (prefix: string): string => prefix.padEnd(64, '0')

const tx = (blockNumber: number, h: string, recipientData?: string): OrderInput => ({
  blockNumber,
  hash: hash(h),
  ...(recipientData === undefined ? {} : { recipientData }),
})

describe('rankMessages — §5.2 canonical order (r27)', () => {
  it('returns nothing for nothing', () => {
    expect(rankMessages([])).toEqual([])
  })

  it('sorts a block by hash, bytewise ascending, whatever order the response used', () => {
    const low = tx(100, 'aa00', NNS)
    const high = tx(100, 'aa10', NNS)
    const ranked = rankMessages([high, low])
    expect(ranked.map((r) => [r.tx.hash, r.txIndex])).toEqual([
      [hash('aa00'), 0],
      [hash('aa10'), 1],
    ])
  })

  it('orders digits before letters — bytewise on lowercase hex, not numerically', () => {
    // '9' (0x39) < 'a' (0x61) in ASCII, which is also the bytewise order of
    // the underlying nibbles. A locale-aware or numeric comparison can differ.
    const nine = tx(100, '9f', NNS)
    const alpha = tx(100, 'a0', NNS)
    expect(rankMessages([alpha, nine]).map((r) => r.tx.hash)).toEqual([hash('9f'), hash('a0')])
  })

  it('ranks per block: block number ascending first, ranks restart at zero', () => {
    const ranked = rankMessages([
      tx(200, 'bb', NNS),
      tx(100, 'ff', NNS), // highest hash, lowest block — still first
      tx(200, 'aa', NNS),
    ])
    expect(ranked.map((r) => [r.tx.blockNumber, r.tx.hash, r.txIndex])).toEqual([
      [100, hash('ff'), 0],
      [200, hash('aa'), 0],
      [200, hash('bb'), 1],
    ])
  })

  it('excludes everything unprefixed — rewards, plain transfers, absent data', () => {
    const message = tx(100, 'cc', NNS)
    const ranked = rankMessages([
      tx(100, 'aa'), // no recipientData at all (an inherent)
      tx(100, 'bb', 'deadbeef'), // data, but not NNS1
      message,
    ])
    expect(ranked).toEqual([{ tx: message, txIndex: 0 }])
  })

  it('is case-insensitive on the prefix and the hash', () => {
    const upper = { blockNumber: 100, hash: hash('AA00').toUpperCase(), recipientData: NNS.toUpperCase() }
    const lower = tx(100, 'aa10', NNS)
    const ranked = rankMessages([lower, upper])
    expect(ranked.map((r) => r.txIndex)).toEqual([0, 1])
    expect(ranked[0]?.tx).toBe(upper)
  })

  it('accepts a 0x-prefixed hash and orders it by its bare bytes', () => {
    const prefixed = { blockNumber: 100, hash: `0x${hash('aa00')}`, recipientData: NNS }
    const bare = tx(100, 'aa10', NNS)
    expect(rankMessages([bare, prefixed]).map((r) => r.txIndex)).toEqual([0, 1])
  })

  it('keeps §7.5-discardable transactions in the universe — the rank is pre-discard', () => {
    // The universe is "NNS1-prefixed, before any discard": executionResult,
    // networkId and the launch filter are not inputs here on purpose. A failed
    // message still occupies its rank; discarding it later cannot move rank 1.
    const failed = { ...tx(100, 'aa00', NNS), executionResult: false }
    const ok = tx(100, 'aa10', NNS)
    const ranked = rankMessages([ok, failed])
    expect(ranked.map((r) => r.txIndex)).toEqual([0, 1])
    expect(ranked[0]?.tx).toBe(failed)
  })

  it('throws on a hash that is not 64 hex chars — it cannot be ordered bytewise', () => {
    expect(() => rankMessages([{ blockNumber: 100, hash: 'abc', recipientData: NNS }])).toThrow(OrderingError)
    expect(() => rankMessages([{ blockNumber: 100, hash: `${'zz'.padEnd(64, '0')}`, recipientData: NNS }])).toThrow(
      OrderingError,
    )
  })

  it('throws on two identical hashes in one block — two ranks cannot tie', () => {
    expect(() => rankMessages([tx(100, 'aa', NNS), tx(100, 'aa', NNS)])).toThrow(OrderingError)
    // The same hash in different blocks is fine (it cannot happen on-chain,
    // but it is not an ordering problem).
    expect(rankMessages([tx(100, 'aa', NNS), tx(200, 'aa', NNS)])).toHaveLength(2)
  })
})
