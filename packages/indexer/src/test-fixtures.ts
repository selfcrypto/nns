/**
 * A fake node: a hand-built chain of blocks, served through the two methods
 * the scan loop uses. Not a test file itself — imported by the tests.
 */

import {
  CONSTANTS,
  addressFromBytes,
  canonicalLogLine,
  formatAddress,
  defineConfig,
  initialState,
  reduce,
  type Address,
  type BuiltTransaction,
  type ChainTransaction,
  type NnsConfig,
  type NnsState,
} from '@nns/core'

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
    // 64 hex chars, as on the wire: §5.2 orders same-block messages by hash,
    // so a fake hash must be orderable. Monotonic, so within one test
    // creation order and hash order agree unless a test overrides the hash.
    hash: counter.toString(16).padStart(64, '0'),
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
  /**
   * Block contents, by height. Array order is response order and means
   * nothing: canonical order is `(blockNumber, hash)` (§5.2, r27).
   */
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

// ── A staged §8.2 log ───────────────────────────────────────────────────────
//
// Transactions go through `core`'s builders for their recipient, value and
// payload, through `core.reduce` for their verdict, and through
// `core.canonicalLogLine` for their line — so a fixture cannot encode a
// message one way and the reducer read it another. What `bootstrap.ts` then
// gets is a list of strings and nothing else, which is exactly what it gets
// from a peer's `/log`.

/** Distinct, valid, and never the all-zero burn address. */
export function testAddress(seed: number): Address {
  if (seed < 1 || seed > 255) throw new Error(`test address seed ${seed} out of range — 0 is BURN_ADDRESS`)
  const bytes = new Uint8Array(20)
  bytes[19] = seed
  return addressFromBytes(bytes)
}

export const SELLER = testAddress(10)
export const BUYER = testAddress(11)

export const LAUNCH_HEIGHT: number = CONSTANTS.LAUNCH_HEIGHT

export const testConfig = (overrides: Partial<Parameters<typeof defineConfig>[0]> = {}): NnsConfig =>
  defineConfig({ networkId: MAINNET, ...overrides })

/** A hash is only ever echoed, so a deterministic stand-in keeps lines stable. */
const fakeHash = (height: number, txIndex: number): string =>
  `${height.toString(16).padStart(32, '0')}${txIndex.toString(16).padStart(32, '0')}`

export interface Send {
  readonly height: number
  readonly txIndex: number
  readonly sender: Address
  readonly built: BuiltTransaction
}

export const send = (height: number, txIndex: number, sender: Address, built: BuiltTransaction): Send => ({
  height,
  txIndex,
  sender,
  built,
})

export function sendToChainTransaction(item: Send, config: NnsConfig): ChainTransaction {
  return {
    blockNumber: item.height,
    txIndex: item.txIndex,
    hash: fakeHash(item.height, item.txIndex),
    sender: item.sender,
    recipient: item.built.recipient,
    value: item.built.value,
    recipientData: item.built.data,
    executionResult: true,
    networkId: config.networkId,
  }
}

export interface StagedLog {
  readonly lines: readonly string[]
  /** The state the staging run ended on — the answer a replay must reach. */
  readonly state: NnsState
}

/** Reduce every send in order and emit the log line each one earns (§7.6). */
export function stageLog(sends: readonly Send[], config: NnsConfig): StagedLog {
  let state = initialState()
  const lines: string[] = []
  for (const item of sends) {
    const chainTx = sendToChainTransaction(item, config)
    const result = reduce(state, chainTx, config)
    state = result.state
    if (result.verdict.kind === 'IGNORED') {
      throw new Error(`fixture send at ${item.height}:${item.txIndex} was ignored`)
    }
    lines.push(canonicalLogLine(chainTx, result.verdict))
  }
  return { lines, state }
}

/**
 * The same sends, as the chain would serve them: one `RpcTransaction` per
 * block, keyed by height for {@link fakeNode}'s `blocks`.
 *
 * The pair with {@link stageLog} is the point — a §8.2 log and a chain that
 * agree by construction, so a test that breaks one of them is testing the
 * disagreement rather than the fixture. One message per block keeps every
 * `tx_index` zero, which is what §5.2's per-block hash rank produces for a
 * block with a single NNS message and what `stageLog` assumes.
 */
export function chainBlocks(
  sends: readonly Send[],
  config: NnsConfig,
): Record<number, readonly RpcTransaction[]> {
  const blocks: Record<number, RpcTransaction[]> = {}
  for (const item of sends) {
    const chainTx = sendToChainTransaction(item, config)
    ;(blocks[item.height] ??= []).push({
      hash: chainTx.hash,
      blockNumber: item.height,
      timestamp: 1_700_000_000 + item.height,
      from: formatAddress(item.sender),
      to: formatAddress(item.built.recipient),
      value: Number(item.built.value),
      fee: 0,
      recipientData: item.built.data,
      networkId: config.networkId,
      executionResult: true,
    })
  }
  return blocks
}

