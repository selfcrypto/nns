/**
 * Albatross batch geometry, and `FINALITY_RULE`.
 *
 * These are chain parameters, not protocol rules — nothing here is a validity
 * decision, so nothing here belongs in `core`.
 *
 * §3: blocks are ~1 s, **60 blocks = 1 batch**. Batch `n` covers blocks
 * `(n-1)*60 + 1 … n*60`, and the block at `n*60` is its **macro block**.
 * Genesis (height 0) is batch 0 and has no body worth scanning.
 */

export const BLOCKS_PER_BATCH = 60

/** The batch a height belongs to. Matches Albatross' `Policy::batch_at`. */
export function batchAt(height: number): number {
  if (height <= 0) return 0
  return Math.ceil(height / BLOCKS_PER_BATCH)
}

/** Height of the macro block that closes a batch. */
export function macroBlockOf(batch: number): number {
  return batch * BLOCKS_PER_BATCH
}

/** Height of the first block of a batch. Batch 0 is genesis alone. */
export function firstBlockOf(batch: number): number {
  return batch <= 0 ? 0 : (batch - 1) * BLOCKS_PER_BATCH + 1
}

/**
 * `FINALITY_RULE` (§3, §7.2 step 3): **state never advances past the last
 * finalised macro block.**
 *
 * An Albatross macro block carries a 2/3 aggregate commit and is final the
 * moment it is produced; micro blocks above it can still be reverted down to
 * it. So the last finalised macro block is simply the highest multiple of 60
 * at or below the head — which makes `lastFinalisedBatch` a floor division,
 * and makes reorg rollback logic unnecessary rather than merely rare.
 *
 * The `head % 60 === 0` case matters: at that instant the head *is* the macro
 * block, and the batch that just closed is already final. Treating "current
 * batch minus one" as the answer would be correct but would lag a full batch
 * for no reason.
 */
export function lastFinalisedBatch(head: number): number {
  if (head <= 0) return 0
  return Math.floor(head / BLOCKS_PER_BATCH)
}

/** Height of the last finalised macro block for a given head. */
export function lastFinalisedHeight(head: number): number {
  return macroBlockOf(lastFinalisedBatch(head))
}

/**
 * Is a height inside a batch? Used to catch the one open question in
 * `docs/rpc-reference.md` §6 — whether `getTransactionsByBatchNumber` really
 * takes a *batch* number and not a *block* number. Feeding it a block number
 * would silently scan the wrong 60 blocks; every transaction it returned
 * would land outside the expected range, so the scan asserts this per batch.
 */
export function heightInBatch(height: number, batch: number): boolean {
  return height >= firstBlockOf(batch) && height <= macroBlockOf(batch)
}
