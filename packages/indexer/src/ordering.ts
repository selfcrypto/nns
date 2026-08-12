/**
 * Canonical position (spec §5.2).
 *
 * The RPC transaction object carries **no index field** — canonical order is
 * `(blockNumber, zero-based position in the block body array)`. So the
 * position has to come from the body itself.
 *
 * `getTransactionsByBatchNumber` cannot supply it: it returns 60 blocks'
 * worth of transactions *plus reward transactions*, and rewards are inherents
 * that never appear in a block body. Counting them would shift every index
 * after them. Identifying them would mean a heuristic on `from`/`proof` that
 * nobody has verified against this node — a heuristic that produces a wrong
 * root, silently, exactly the failure mode the whole design exists to prevent.
 *
 * So we don't guess. NNS transactions are rare (a handful a day against 720
 * batches), so after the `NNS1` prefix filter we fetch the body of each block
 * that actually contains one and read the position off the array. A micro
 * block body holds real transactions only, which is precisely what §5.2 means
 * by "the block body array". Cost is one extra call per NNS-bearing block,
 * and the answer is exact rather than inferred.
 */

import type { RpcClient, RpcTransaction } from './rpc.js'

export class OrderingError extends Error {
  override readonly name = 'OrderingError'
}

export interface Positioned<T> {
  readonly tx: T
  /** Zero-based position in the block body array. */
  readonly txIndex: number
}

/**
 * Resolve the body position of every given transaction.
 *
 * Throws rather than falling back to array order: an unresolvable position is
 * a divergence, not a degraded mode.
 */
export async function resolvePositions(
  rpc: Pick<RpcClient, 'getBlockByNumber'>,
  transactions: readonly RpcTransaction[],
): Promise<readonly Positioned<RpcTransaction>[]> {
  if (transactions.length === 0) return []

  const heights = [...new Set(transactions.map((tx) => tx.blockNumber))].sort((a, b) => a - b)
  const positions = new Map<string, number>()

  for (const height of heights) {
    const block = await rpc.getBlockByNumber(height, true)
    const body = block.transactions
    if (body === undefined) {
      throw new OrderingError(`block ${height}: requested with the body, got none — cannot establish §5.2 order`)
    }
    body.forEach((entry, index) => positions.set(key(height, entry.hash), index))
  }

  return transactions
    .map((tx) => {
      const index = positions.get(key(tx.blockNumber, tx.hash))
      if (index === undefined) {
        throw new OrderingError(
          `transaction ${tx.hash} is reported in block ${tx.blockNumber} but is absent from that block's body`,
        )
      }
      return { tx, txIndex: index }
    })
    .sort(compare)
}

function key(height: number, hash: string): string {
  return `${height}:${hash.toLowerCase()}`
}

/** Ascending block number, then ascending body position (§7.2 step 2). */
export function compare(a: Positioned<RpcTransaction>, b: Positioned<RpcTransaction>): number {
  return a.tx.blockNumber - b.tx.blockNumber || a.txIndex - b.txIndex
}
