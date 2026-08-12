/**
 * A fake node: a hand-built chain of blocks, served through the two methods
 * the scan loop uses. Not a test file itself — imported by the tests.
 */

import { firstBlockOf, macroBlockOf } from './chain.js'
import { createLogger, type Logger } from './logger.js'
import type { RpcBlock, RpcTransaction } from './rpc.js'
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
  /** Block bodies, by height. Order within an array is the canonical order. */
  blocks?: Record<number, readonly RpcTransaction[]>
  /** Extra entries the batch call returns that are NOT in any body (rewards). */
  inherents?: readonly RpcTransaction[]
  consensus?: boolean
}

export interface FakeNode {
  rpc: ScanRpc
  calls: { batches: number[]; blocks: number[] }
  setHead(head: number): void
}

export function fakeNode(options: FakeNodeOptions): FakeNode {
  const blocks = options.blocks ?? {}
  const inherents = options.inherents ?? []
  let head = options.head
  const calls = { batches: [] as number[], blocks: [] as number[] }

  const rpc: ScanRpc = {
    isConsensusEstablished: async () => options.consensus ?? true,
    getBlockNumber: async () => head,
    getBatchNumber: async () => Math.ceil(head / 60),
    getTransactionsByBatchNumber: async (batch: number): Promise<readonly RpcTransaction[]> => {
      calls.batches.push(batch)
      const from = firstBlockOf(batch)
      const to = macroBlockOf(batch)
      const inRange: RpcTransaction[] = []
      for (let height = from; height <= to; height += 1) {
        inRange.push(...(blocks[height] ?? []))
      }
      inRange.push(...inherents.filter((entry) => entry.blockNumber >= from && entry.blockNumber <= to))
      return inRange
    },
    getBlockByNumber: async (height: number, includeBody: boolean): Promise<RpcBlock> => {
      calls.blocks.push(height)
      const body = blocks[height] ?? []
      return includeBody
        ? { number: height, hash: `block${height}`, transactions: body }
        : { number: height, hash: `block${height}` }
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
