/**
 * A fake node: a hand-built chain of blocks, served through the two methods
 * the scan loop uses. Not a test file itself — imported by the tests.
 */

import { BLOCKS_PER_BATCH } from './chain.js'
import { createLogger, type Logger } from './logger.js'
import { RpcError, type RpcBlock, type RpcTransaction } from './rpc.js'
import type { ScanRpc } from './scan.js'

export const MAINNET = 24

/** `NNS1G` + `hello.world` style payload, hex-encoded as the RPC returns it. */
export function payload(ascii: string): string {
  return Buffer.from(ascii, 'ascii').toString('hex')
}

let counter = 0

export function tx(overrides: Partial<RpcTransaction> & { blockNumber: number }): RpcTransaction {
  counter += 1
  return {
    hash: `hash${counter.toString().padStart(4, '0')}`,
    timestamp: 1_700_000_000 + counter,
    from: 'NQ11 1111 1111 1111 1111 1111 1111 1111 1111',
    to: 'NQ22 2222 2222 2222 2222 2222 2222 2222 2222',
    value: 1,
    fee: 0,
    recipientData: '',
    networkId: MAINNET,
    executionResult: true,
    ...overrides,
  }
}

export interface FakeNodeOptions {
  head: number
  /**
   * PoS genesis. Batch numbering starts here, not at block 0 — the fake
   * numbers its batches the way mainnet does so a test can exercise the real
   * offset. Defaults to 0, which keeps the arithmetic in the other tests
   * readable.
   */
  genesis?: number
  /** Block bodies, by height. Order within an array is the canonical order. */
  blocks?: Record<number, readonly RpcTransaction[]>
  /** Extra entries the batch call returns that are NOT in any body (rewards). */
  inherents?: readonly RpcTransaction[]
  consensus?: boolean
  /**
   * History horizon: the earliest block still held. Below it `getBlockByNumber`
   * errors the way a pruned node's does, while the batch call keeps answering
   * `[]` — which is the whole trap.
   */
  horizon?: number
}

export interface FakeNode {
  rpc: ScanRpc
  /** `blocks` counts body reads only; calibration probes are counted apart. */
  calls: { batches: number[]; blocks: number[]; probes: number[] }
  setHead(head: number): void
}

export function fakeNode(options: FakeNodeOptions): FakeNode {
  const blocks = options.blocks ?? {}
  const inherents = options.inherents ?? []
  const genesis = options.genesis ?? 0
  let head = options.head
  const calls = { batches: [] as number[], blocks: [] as number[], probes: [] as number[] }

  // How Albatross numbers batches: genesis-relative, one-based, closed by the
  // macro block at `genesis + batch * 60`.
  const batchOf = (height: number): number => Math.ceil((height - genesis) / BLOCKS_PER_BATCH)

  const rpc: ScanRpc = {
    isConsensusEstablished: async () => options.consensus ?? true,
    getBlockNumber: async () => head,
    getBatchNumber: async () => batchOf(head),
    getTransactionsByBatchNumber: async (batch: number): Promise<readonly RpcTransaction[]> => {
      calls.batches.push(batch)
      const from = genesis + (batch - 1) * BLOCKS_PER_BATCH + 1
      const to = genesis + batch * BLOCKS_PER_BATCH
      const inRange: RpcTransaction[] = []
      for (let height = from; height <= to; height += 1) {
        inRange.push(...(blocks[height] ?? []))
      }
      inRange.push(...inherents.filter((entry) => entry.blockNumber >= from && entry.blockNumber <= to))
      return inRange
    },
    getBlockByNumber: async (height: number, includeBody: boolean): Promise<RpcBlock> => {
      ;(includeBody ? calls.blocks : calls.probes).push(height)
      if ((options.horizon !== undefined && height < options.horizon) || height > head) {
        // The node's own shape: a flat message, the detail in `data`.
        throw new RpcError('getBlockByNumber', -32603, 'Internal error', `Block not found: ${height}`)
      }
      // Every block carries its own batch and type, as the node's do.
      const header = {
        number: height,
        hash: `block${height}`,
        batch: batchOf(height),
        type: height > genesis && (height - genesis) % BLOCKS_PER_BATCH === 0 ? 'macro' : 'micro',
      }
      return includeBody ? { ...header, transactions: blocks[height] ?? [] } : header
    },
  }

  return {
    rpc,
    calls,
    setHead(next: number) {
      head = next
    },
  }
}

/** A logger that collects lines as parsed objects. */
export function collectingLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = []
  const logger = createLogger({
    level: 'debug',
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  })
  return { logger, lines }
}
