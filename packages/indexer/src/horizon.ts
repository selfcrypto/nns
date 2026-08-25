/**
 * The node's history horizon — the guard that stops an indexer from succeeding
 * at nothing.
 *
 * A node brought up by state sync, or one that has pruned past
 * `max_epochs_stored`, holds no blocks below its sync point.
 * `getTransactionsByBatchNumber` answers a batch below that point with `[]` —
 * **the same answer as a genuinely empty batch** (`docs/rpc-reference.md`,
 * measured 2026-08-14). So an indexer started below the horizon scans its whole
 * backfill, discovers nothing, logs nothing, and reports success with an empty
 * registry. Worse, it does so *reproducibly*: two indexers on the same pruned
 * node derive identical, identically wrong checkpoints, and the determinism
 * evidence agrees with them.
 *
 * `getBlockByNumber` is the only method that separates the two cases: a block
 * the node no longer holds is an error, an empty batch is not. One probe
 * answers the question at startup; a bisection over the same call names the
 * earliest block held, and costs ~20 calls on the path that is about to abort
 * anyway.
 *
 * This is the mechanism `scripts/determinism.mjs` refuses to run below, and it
 * imports these functions rather than carrying its own copy.
 */

import type { Logger } from './logger.js'
import { RpcError, type RpcClient } from './rpc.js'

/** Raised at startup when the node cannot serve the window the scan needs. */
export class HorizonError extends Error {
  override readonly name = 'HorizonError'
  /** The first block the scan needed to read. */
  readonly startHeight: number
  /** The earliest block the node still holds. */
  readonly earliestBlock: number

  constructor(message: string, heights: { startHeight: number; earliestBlock: number }) {
    super(message)
    this.startHeight = heights.startHeight
    this.earliestBlock = heights.earliestBlock
  }
}

/** Everything the guard reads. Structural, so the harness can pass its own client. */
export type HorizonRpc = Pick<RpcClient, 'getBlockNumber' | 'getBlockByNumber'>

/**
 * "Block not found", whoever raised it.
 *
 * The node puts a flat `"Internal error"` in `message` and the useful half in
 * `data: "Block not found: 58177017"`, so `message` alone cannot tell a pruned
 * block from a broken node. Matching over both is also what lets a caller
 * holding a plain `fetch` wrapper — the determinism harness — reuse this.
 *
 * The match wants the node's whole phrase, not just "not found": a proxy or a
 * typo'd path answering a bare `HTTP 404 Not Found` is a broken endpoint, and
 * classifying it as a pruned block would bisect on garbage and hand the
 * operator a plausible-looking horizon instead of the real failure.
 */
function isMissingBlock(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const detail = error instanceof RpcError ? `${error.message} ${String(error.data ?? '')}` : error.message
  return /block not found/i.test(detail)
}

/** Does the node still hold this block? Any other failure propagates. */
export async function holdsBlock(rpc: HorizonRpc, height: number): Promise<boolean> {
  try {
    await rpc.getBlockByNumber(height, false)
    return true
  } catch (error) {
    if (isMissingBlock(error)) return false
    throw error
  }
}

/**
 * The earliest block the node holds, by bisection.
 *
 * `missing` must be known absent and `present` known held — the search only
 * narrows an interval it is given, it does not verify its ends.
 */
export async function earliestBlockHeld(rpc: HorizonRpc, missing: number, present: number): Promise<number> {
  let low = missing
  let high = present
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (await holdsBlock(rpc, middle)) high = middle
    else low = middle
  }
  return high
}

/**
 * The horizon as it bears on one start height: `null` when there is nothing to
 * report, the earliest block held when the node cannot serve it.
 *
 * A start height **above the head** is not a horizon problem — a launch height
 * the chain has not reached yet is a legitimate configuration, and the scan
 * simply idles until it does.
 */
export async function historyHorizon(rpc: HorizonRpc, startHeight: number): Promise<number | null> {
  if (await holdsBlock(rpc, startHeight)) return null
  const head = await rpc.getBlockNumber()
  if (startHeight > head) return null
  return await earliestBlockHeld(rpc, startHeight, head)
}

export interface HorizonCheck {
  rpc: HorizonRpc
  /** The first block the scan will need to read. */
  startHeight: number
  /** Where that height came from, named in the refusal. */
  origin: string
  logger?: Logger | undefined
}

/**
 * Refuse to scan a window the node does not hold.
 *
 * Costs one call when the history is there, which is every start but the
 * broken one.
 */
export async function assertHistoryHorizon({ rpc, startHeight, origin, logger }: HorizonCheck): Promise<void> {
  const earliest = await historyHorizon(rpc, startHeight)
  if (earliest === null) {
    logger?.debug('chain.horizon-ok', { startHeight, origin })
    return
  }
  throw new HorizonError(
    `the node has no block at ${origin} ${startHeight.toLocaleString()} — its history starts at ` +
      `${earliest.toLocaleString()}.\n` +
      '  A batch below that answers with an empty transaction list, not an error, so the scan would run\n' +
      '  the whole backfill, find nothing, and report success with an empty registry — reproducibly, so a\n' +
      '  second indexer would agree with it.\n' +
      `  Re-index the node with history, or start at or above ${earliest.toLocaleString()}.`,
    { startHeight, earliestBlock: earliest },
  )
}
