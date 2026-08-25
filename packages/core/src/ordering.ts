/**
 * Canonical order and `tx_index` (spec §5.2, r27).
 *
 * Canonical order is `(block_number ascending, transaction hash ascending,
 * bytewise)`, and `tx_index` is a transaction's zero-based **rank** in that
 * order within its block. The rank's universe is pinned exactly: every
 * transaction in the block whose `recipientData` begins with `NNS1`, taken
 * **before** any §7.5 discard — a failed or wrong-network message still
 * occupies its rank, and everything unprefixed is invisible to the count.
 * That is the only set every implementation can derive from the batch
 * response alone, and any other reading forks the roots.
 *
 * This file is the one implementation of the rule. Through r26 the second
 * coordinate was the position in the block body array, which the RPC
 * transaction object does not carry — so it lived in the indexer as a
 * per-block body fetch, and every other implementation re-derived it against
 * an RPC quirk. The hash is on every object `getTransactionsByBatchNumber`
 * returns, so the rank is a pure function of the batch response, like every
 * other consensus rule here.
 *
 * Hashes compare **bytewise ascending**. On lowercase hex strings that is
 * plain lexicographic order (`0-9 < a-f` in ASCII), so the comparison
 * lowercases first and never touches locale-aware collation.
 */

import { CONSTANTS } from './constants.js'

export class OrderingError extends Error {
  override readonly name = 'OrderingError'
}

/** `NNS1` as lowercase hex — `recipientData` is hex on the wire (§5.1). */
const PREFIX_HEX = [...CONSTANTS.PROTOCOL_ID].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')

/** What the rank derivation needs from a transaction — a subset of the batch response. */
export interface OrderInput {
  readonly blockNumber: number
  /** Transaction hash, 64 hex chars, either case, optionally `0x`-prefixed. */
  readonly hash: string
  /** Hex. Absent on plain transfers and inherents — absent is never a message. */
  readonly recipientData?: string | undefined
}

/** A transaction in the §5.2 universe, stamped with its canonical rank. */
export interface Ranked<T extends OrderInput> {
  readonly tx: T
  /** Zero-based rank in `(blockNumber, hash)` order within the block. */
  readonly txIndex: number
}

function bareHash(tx: OrderInput): string {
  const raw = tx.hash.startsWith('0x') || tx.hash.startsWith('0X') ? tx.hash.slice(2) : tx.hash
  const hash = raw.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new OrderingError(
      `transaction in block ${tx.blockNumber} has a hash that is not 64 hex chars: ${JSON.stringify(tx.hash)}`,
    )
  }
  return hash
}

/**
 * Rank a set of transactions per §5.2: keep the `NNS1`-prefixed ones, sort
 * them `(blockNumber ascending, hash ascending bytewise)`, and stamp each
 * with its zero-based rank within its block.
 *
 * The input may span any number of blocks (a batch response does) and may be
 * in any order. Nothing else about the input matters — inherents, rewards and
 * plain transfers carry no `NNS1` prefix and fall out of the universe here,
 * which is why the reward-inherent counting hazard of the body-position rule
 * cannot exist under this one.
 *
 * Throws rather than guessing: a malformed hash cannot be ordered bytewise,
 * and two identical hashes in one block cannot hold two distinct ranks — both
 * are broken inputs, not degraded modes.
 */
export function rankMessages<T extends OrderInput>(transactions: readonly T[]): readonly Ranked<T>[] {
  const universe = transactions
    .filter((tx) => tx.recipientData !== undefined && tx.recipientData.toLowerCase().startsWith(PREFIX_HEX))
    .map((tx) => ({ tx, hash: bareHash(tx) }))

  universe.sort((a, b) => a.tx.blockNumber - b.tx.blockNumber || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))

  const ranked: Ranked<T>[] = []
  let blockNumber = -1
  let rank = 0
  let previousHash = ''
  for (const { tx, hash } of universe) {
    if (tx.blockNumber !== blockNumber) {
      blockNumber = tx.blockNumber
      rank = 0
    } else {
      if (hash === previousHash) {
        throw new OrderingError(`two transactions in block ${blockNumber} share the hash ${hash}`)
      }
      rank += 1
    }
    previousHash = hash
    ranked.push({ tx, txIndex: rank })
  }
  return ranked
}
