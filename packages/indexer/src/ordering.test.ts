import { describe, expect, it } from 'vitest'

import { OrderingError, resolvePositions } from './ordering.js'
import { fakeNode, tx } from './test-fixtures.js'

describe('resolvePositions', () => {
  it('returns nothing for nothing, without touching the node', async () => {
    const node = fakeNode({ head: 120 })
    expect(await resolvePositions(node.rpc, [])).toEqual([])
    expect(node.calls.blocks).toEqual([])
  })

  it('fetches each block once, however many transactions it holds', async () => {
    const a = tx({ blockNumber: 61 })
    const b = tx({ blockNumber: 61 })
    const node = fakeNode({ head: 120, blocks: { 61: [a, b] } })
    const positioned = await resolvePositions(node.rpc, [a, b])
    expect(node.calls.blocks).toEqual([61])
    expect(positioned.map((p) => p.txIndex)).toEqual([0, 1])
  })

  it('sorts by block then body position regardless of input order', async () => {
    const first = tx({ blockNumber: 61 })
    const second = tx({ blockNumber: 61 })
    const later = tx({ blockNumber: 62 })
    const node = fakeNode({ head: 120, blocks: { 61: [first, second], 62: [later] } })
    const positioned = await resolvePositions(node.rpc, [later, second, first])
    expect(positioned.map((p) => [p.tx.blockNumber, p.txIndex])).toEqual([
      [61, 0],
      [61, 1],
      [62, 0],
    ])
  })

  it('throws when a transaction is absent from the body it claims', async () => {
    // A reward inherent looks like this: reported in a block, not in its body.
    const ghost = tx({ blockNumber: 61 })
    const node = fakeNode({ head: 120, blocks: { 61: [] } })
    await expect(resolvePositions(node.rpc, [ghost])).rejects.toThrow(OrderingError)
  })

  it('throws rather than guessing when a body is missing entirely', async () => {
    const orphan = tx({ blockNumber: 61 })
    const rpc = { getBlockByNumber: async () => ({ number: 61, hash: 'x' }) }
    await expect(resolvePositions(rpc, [orphan])).rejects.toThrow(/cannot establish/)
  })

  it('matches hashes case-insensitively', async () => {
    const entry = tx({ blockNumber: 61, hash: 'ABCD' })
    const node = fakeNode({ head: 120, blocks: { 61: [{ ...entry, hash: 'abcd' }] } })
    const positioned = await resolvePositions(node.rpc, [entry])
    expect(positioned[0]?.txIndex).toBe(0)
  })
})
