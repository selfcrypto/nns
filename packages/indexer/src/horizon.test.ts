import { describe, expect, it } from 'vitest'

import {
  HorizonError,
  assertHistoryHorizon,
  earliestBlockHeld,
  historyHorizon,
  holdsBlock,
  type HorizonRpc,
} from './horizon.js'
import { RpcError, RpcTransportError } from './rpc.js'
import { collectingLogger } from './test-fixtures.js'

/** A node holding `[horizon, head]` and nothing else, counting its probes. */
function node(horizon: number, head: number): { rpc: HorizonRpc; probes: number[] } {
  const probes: number[] = []
  const rpc: HorizonRpc = {
    getBlockNumber: async () => head,
    getBlockByNumber: async (height: number) => {
      probes.push(height)
      if (height < horizon || height > head) {
        // The node's own shape: "Internal error" in `message`, the useful half
        // in `data` (docs/rpc-reference.md, getBlockByNumber).
        throw new RpcError('getBlockByNumber', -32603, 'Internal error', `Block not found: ${height}`)
      }
      return { number: height, hash: `block${height}` }
    },
  }
  return { rpc, probes }
}

describe('holdsBlock', () => {
  it('reads a "Block not found" out of `data`, which `message` does not carry', async () => {
    const { rpc } = node(1_000, 2_000)
    expect(await holdsBlock(rpc, 1_500)).toBe(true)
    expect(await holdsBlock(rpc, 999)).toBe(false)
  })

  it('propagates anything that is not a missing block', async () => {
    const rpc: HorizonRpc = {
      getBlockNumber: async () => 2_000,
      getBlockByNumber: async () => {
        throw new RpcTransportError('getBlockByNumber: request failed')
      },
    }
    // A node that is merely unreachable must not be reported as pruned — that
    // would name a horizon it never gave us.
    await expect(holdsBlock(rpc, 1_500)).rejects.toThrow(RpcTransportError)
  })
})

describe('earliestBlockHeld', () => {
  it('names the first block held, exactly', async () => {
    const { rpc } = node(58_842_660, 58_900_000)
    expect(await earliestBlockHeld(rpc, 58_177_017, 58_900_000)).toBe(58_842_660)
  })

  it('costs a bisection, not a walk', async () => {
    const { rpc, probes } = node(58_842_660, 58_900_000)
    await earliestBlockHeld(rpc, 58_177_017, 58_900_000)
    // log2(722,983) ≈ 20.
    expect(probes.length).toBeLessThanOrEqual(21)
  })

  it('handles a horizon one block above the missing end', async () => {
    const { rpc } = node(101, 200)
    expect(await earliestBlockHeld(rpc, 100, 200)).toBe(101)
  })
})

describe('historyHorizon', () => {
  it('reports nothing when the block is held, at the cost of one call', async () => {
    const { rpc, probes } = node(1_000, 2_000)
    expect(await historyHorizon(rpc, 1_000)).toBeNull()
    expect(probes).toEqual([1_000])
  })

  it('reports the earliest block held when it is not', async () => {
    const { rpc } = node(1_000, 2_000)
    expect(await historyHorizon(rpc, 500)).toBe(1_000)
  })

  it('is silent about a start height the chain has not reached', async () => {
    // A launch height announced ahead of time is a legitimate configuration:
    // the scan idles until the chain arrives. It is not a pruned node.
    const { rpc } = node(1_000, 2_000)
    expect(await historyHorizon(rpc, 5_000)).toBeNull()
  })
})

describe('assertHistoryHorizon', () => {
  it('names both heights and where the start height came from', async () => {
    const { rpc } = node(58_842_660, 58_900_000)
    const { logger } = collectingLogger()
    const error = await assertHistoryHorizon({
      rpc,
      startHeight: 58_764_940,
      origin: 'LAUNCH_HEIGHT',
      logger,
    }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(HorizonError)
    const horizon = error as HorizonError
    expect(horizon.startHeight).toBe(58_764_940)
    expect(horizon.earliestBlock).toBe(58_842_660)
    expect(horizon.message).toContain('LAUNCH_HEIGHT 58,764,940')
    expect(horizon.message).toContain('58,842,660')
  })

  it('passes when the node holds the start height', async () => {
    const { rpc } = node(1_000, 2_000)
    const { logger } = collectingLogger()
    await expect(
      assertHistoryHorizon({ rpc, startHeight: 1_000, origin: 'LAUNCH_HEIGHT', logger }),
    ).resolves.toBeUndefined()
  })
})
