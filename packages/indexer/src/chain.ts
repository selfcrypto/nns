/**
 * Albatross batch geometry, and `FINALITY_RULE`.
 *
 * These are chain parameters, not protocol rules — nothing here is a validity
 * decision, so nothing here belongs in `core`.
 *
 * **Batch numbers are relative to the PoS genesis, not to block 0.** Measured
 * on mainnet: head 58,707,553 is batch **920,860**, and batch 920,860 spans
 * blocks 58,707,541–58,707,600. Deriving a batch as `floor(height / 60)` gives
 * 978,459 — 57,599 batches too high. It does not throw. It just scans a part
 * of the chain that does not exist, finds nothing, and reports success.
 *
 * So a batch number is never computed from a height here. It is **read from
 * the node**: `getBatchNumber` for the current batch, and the `batch` field
 * that every block object carries for anything else.
 */

import type { Logger } from './logger.js'
import type { RpcClient } from './rpc.js'

/** §3: blocks are ~1 s, 60 blocks = 1 batch ≈ 1 min. */
export const BLOCKS_PER_BATCH = 60

export class CalibrationError extends Error {
  override readonly name = 'CalibrationError'
}

/**
 * `FINALITY_RULE` (§3, §7.2 step 3): **state never advances past the last
 * finalised macro block.**
 *
 * A batch ends with a macro block, and an Albatross macro block carries a 2/3
 * aggregate commit — it is final the moment it is produced. So once batch
 * `n + 1` has begun, batch `n`'s macro block exists and is final, and the last
 * finalised batch is the one below the current one.
 *
 * The argument is **`getBatchNumber`'s answer**, never a height. Because the
 * scan never crosses this line, reorgs need no rollback logic at all rather
 * than merely rarely.
 */
export function lastFinalisedBatch(currentBatch: number): number {
  return Math.max(0, currentBatch - 1)
}

/**
 * Block ↔ batch arithmetic, anchored on the PoS genesis height.
 *
 * Only valid with an **exact** `genesisBlock`, which is why the only way to
 * get one of these is `calibrate()` — reading the anchor from the node rather
 * than hardcoding a constant that would silently rot across a network reset.
 */
export interface ChainGeometry {
  /** The PoS genesis height, measured from the node. Mainnet: 3,456,000. */
  readonly genesisBlock: number
  readonly blocksPerBatch: number
  batchAt(height: number): number
  firstBlockOf(batch: number): number
  /** Height of the macro block that closes a batch. */
  macroBlockOf(batch: number): number
  heightInBatch(height: number, batch: number): boolean
}

export function geometryFor(genesisBlock: number): ChainGeometry {
  const firstBlockOf = (batch: number): number =>
    batch <= 0 ? genesisBlock : genesisBlock + (batch - 1) * BLOCKS_PER_BATCH + 1
  const macroBlockOf = (batch: number): number => genesisBlock + batch * BLOCKS_PER_BATCH

  return Object.freeze({
    genesisBlock,
    blocksPerBatch: BLOCKS_PER_BATCH,
    batchAt: (height: number): number =>
      height <= genesisBlock ? 0 : Math.ceil((height - genesisBlock) / BLOCKS_PER_BATCH),
    firstBlockOf,
    macroBlockOf,
    heightInBatch: (height: number, batch: number): boolean =>
      height >= firstBlockOf(batch) && height <= macroBlockOf(batch),
  })
}

type BlockReader = Pick<RpcClient, 'getBlockNumber' | 'getBlockByNumber'>

/**
 * Measure the PoS genesis height from the node, once, at startup.
 *
 * `head - batchNumber * 60` gets close but is only a **lower bound**: the
 * batch number is a ceiling, so the remainder is unobservable and one sample
 * pins genesis no better than a 60-wide window. On the mainnet pair above it
 * yields 3,455,953, which is 47 short of the true 3,456,000 — enough to put
 * every batch's block range off by 47 and make the scan's range check throw on
 * ordinary traffic.
 *
 * So the bound is the starting point, not the answer. Since every block object
 * carries its own `batch`, the batch boundary can be found exactly:
 *
 * 1. Read the head, then read *that block* — the pair is consistent by
 *    construction, with no race against a chain that advances mid-calibration.
 * 2. Binary search the 60 blocks ending at the head for the first one whose
 *    `batch` is the head's. That block is `firstBlockOf(currentBatch)`.
 * 3. Genesis follows, and the block below it must be a macro block — checked,
 *    because an anchor that cannot be verified is the kind of assumption this
 *    whole design exists to eliminate.
 *
 * About nine calls, once.
 */
export async function calibrate(rpc: BlockReader, logger?: Logger): Promise<ChainGeometry> {
  const head = await rpc.getBlockNumber()
  const headBlock = await rpc.getBlockByNumber(head, false)
  const currentBatch = headBlock.batch
  if (currentBatch === undefined) {
    throw new CalibrationError(
      `block ${head} carries no "batch" field — the genesis anchor cannot be measured, and it must never be guessed`,
    )
  }
  if (currentBatch < 1) {
    throw new CalibrationError(`node reports batch ${currentBatch} at height ${head}; nothing has been finalised yet`)
  }

  // The window is exactly the 60 blocks ending at the head: the current
  // batch's first block cannot be further back than that.
  let low = Math.max(1, head - BLOCKS_PER_BATCH + 1)
  let high = head
  let probes = 2
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const block = await rpc.getBlockByNumber(middle, false)
    probes += 1
    if (block.batch === undefined) {
      throw new CalibrationError(`block ${middle} carries no "batch" field`)
    }
    // `batch` is non-decreasing in height, so this is a clean boundary search.
    if (block.batch >= currentBatch) high = middle
    else low = middle + 1
  }

  const firstBlock = low
  const genesisBlock = firstBlock - 1 - (currentBatch - 1) * BLOCKS_PER_BATCH

  // The block below a batch's first block is the previous batch's macro block.
  // If that is not what the node says, the anchor is wrong and everything
  // downstream would be wrong with it.
  if (firstBlock - 1 > genesisBlock) {
    const boundary = await rpc.getBlockByNumber(firstBlock - 1, false)
    probes += 1
    if (boundary.type !== undefined && boundary.type !== 'macro') {
      throw new CalibrationError(
        `expected a macro block at ${firstBlock - 1} closing batch ${currentBatch - 1}, node says "${boundary.type}" — ` +
          `genesis anchor ${genesisBlock} is not trustworthy`,
      )
    }
  }

  const geometry = geometryFor(genesisBlock)
  logger?.info('chain.calibrated', {
    head,
    currentBatch,
    genesisBlock,
    firstBlockOfCurrentBatch: firstBlock,
    // What the naive derivation would have said, for the log record.
    lowerBoundWas: head - currentBatch * BLOCKS_PER_BATCH,
    probes,
  })
  return geometry
}
