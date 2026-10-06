/**
 * The issuer's guards: what must hold before a hot key signs.
 *
 * **What these are for, exactly.** They protect against a bug in our own
 * pipeline — the indexer, the API, the replay, this package — producing a
 * debt that is wrong. They do **not** protect against a stolen key: a thief
 * signs directly and never runs this code. Nothing here should be read as
 * more than that.
 *
 * Every debt this service pays is part of a payment somebody made to the
 * address that now owes it. The guards hold the issuer to that:
 *
 * | Guard | Holds | Breach |
 * |---|---|---|
 * | Deposit (`unbacked`) | the legs the log charges under one ref never exceed what that transaction paid in, to the address that owes them | `UNBACKED` |
 * | Deposit (`verifyDeposit`) | the node holds that transaction, at that height, to that address, for that value | `DEPOSIT_MISMATCH` |
 * | Solvency (`insolvent`) | `MARKETPLACE_ADDRESS` holds every debt it owes and every standing bid | `INSOLVENT` |
 *
 * A breach pauses the issuer (`pauses` in the ledger, migration `004`) until
 * an operator releases it. Being unable to *compute* a guard is not a breach
 * and not a pause: the leg is simply not paid, and is tried again next cycle.
 *
 * There is no per-payout cap. A legitimate payout scales with the price
 * table — a lost race for a five-character name refunds 15,625 NIM — so a
 * number either holds honest refunds or stops nothing. The deposit bound is
 * the per-payout limit: a payout can be as large as the payment behind it.
 *
 * There is no daily cap either, for the same reason: a few lost races for long
 * names add up to more than any number that is not also a thief's budget, and
 * every leg is already bound to a deposit the node confirms.
 *
 * The treasury has no solvency guard. It holds fee income and is swept by
 * design (§10.6), so its balance says nothing about whether a debt is right;
 * a shortfall there is the existing `UNFUNDED`.
 */

import { CONSTANTS, formatAddress, parseAddress, type Address } from '@nimiqnames/core'

import type { IssuerRpc } from './issue.js'
import type { LedgerEntry } from './ledger.js'
import type { DueObligation, WatchSnapshot } from './watch.js'

export type PauseReason = 'UNBACKED' | 'DEPOSIT_MISMATCH' | 'INSOLVENT'

/** A guard that did not hold. `key` names the leg, for the two deposit guards. */
export interface Breach {
  readonly reason: PauseReason
  readonly key: string | null
  readonly detail: string
}

/**
 * How far behind the head a checkpoint may be and still be paid against.
 *
 * The solvency guard compares a balance read at the head with debts known at
 * the checkpoint, and the further apart the two are the less the comparison
 * says. Normal lag is one interval; ten is an indexer that has stopped. Not a
 * finality rule — finality is inherited from the source — and not a pause: a
 * late checkpoint catches up without anyone acting.
 */
export const MAX_CHECKPOINT_LAG = CONSTANTS.CHECKPOINT_INTERVAL * 10

const nim = (luna: bigint): string => `${luna / 100_000n}.${(luna % 100_000n).toString().padStart(5, '0')}`

/** The deposit guard's first half: the log's own books, no node. */
export function unbacked(leg: DueObligation): Breach | null {
  const breach = (detail: string): Breach => ({ reason: 'UNBACKED', key: leg.key, detail })
  if (leg.deposit === null) return breach(`${leg.key} names a transaction the log does not hold`)
  if (leg.deposit.recipient !== leg.owedBy) {
    return breach(
      `${leg.key} is owed by ${formatAddress(leg.owedBy)}, and the payment it names went to ${formatAddress(leg.deposit.recipient)}`,
    )
  }
  if (leg.refCreated > leg.deposit.value) {
    return breach(
      `the log charges ${nim(leg.refCreated)} NIM under ${leg.key.slice(0, leg.key.lastIndexOf(':'))}, and that transaction paid in ${nim(leg.deposit.value)} NIM`,
    )
  }
  return null
}

/** The node's own word for "no such transaction" (`docs/rpc-reference.md`, `getTransactionByHash`). */
const notFound = (cause: unknown): boolean =>
  String((cause as { data?: unknown }).data ?? '').startsWith('Transaction not found')

/**
 * The deposit guard's second half: the node holds the payment the log names.
 *
 * This is the one check that does not rest on the log, so it is the one that
 * catches a line the indexer or the API invented or inflated. Both read the
 * same node, so it is independent of them and not of the node.
 *
 * The logged sender is not compared: it is the §7.2 effective sender, which
 * for an HTLC is not the account the node reports.
 *
 * @throws whatever the RPC throws when the node could not be asked. That is
 *   not a breach — the caller does not pay the leg and tries again.
 */
export async function verifyDeposit(rpc: IssuerRpc, leg: DueObligation): Promise<Breach | null> {
  const breach = (detail: string): Breach => ({ reason: 'DEPOSIT_MISMATCH', key: leg.key, detail })
  const deposit = leg.deposit
  if (deposit === null) return unbacked(leg)

  let tx: { blockNumber?: unknown; to?: unknown; value?: unknown; executionResult?: unknown }
  try {
    tx = await rpc.call('getTransactionByHash', [deposit.txHash])
  } catch (cause) {
    if (notFound(cause)) return breach(`the node holds no transaction ${deposit.txHash}, which the log puts at ${leg.ref.height}`)
    throw cause
  }

  let to: Address | null = null
  try {
    to = parseAddress(String(tx?.to))
  } catch {
    // Reported below with what the node actually said.
  }
  if (tx?.blockNumber !== leg.ref.height) {
    return breach(`${deposit.txHash} is in block ${JSON.stringify(tx?.blockNumber)} on the node, the log puts it at ${leg.ref.height}`)
  }
  if (to !== deposit.recipient) {
    return breach(`${deposit.txHash} pays ${JSON.stringify(tx?.to)} on the node, the log says ${formatAddress(deposit.recipient)}`)
  }
  if (typeof tx.value !== 'number' || BigInt(tx.value) !== deposit.value) {
    return breach(`${deposit.txHash} carries ${JSON.stringify(tx.value)} luna on the node, the log says ${deposit.value}`)
  }
  if (tx.executionResult !== true) {
    return breach(`${deposit.txHash} failed on chain (executionResult ${JSON.stringify(tx.executionResult)}) and moved no money`)
  }
  return null
}

/**
 * Solvency of `MARKETPLACE_ADDRESS`, the one address that holds other
 * people's money between a payment and its settlement.
 *
 *     balance(head) + inFlight  ≥  due(H) + standingBids(H) + fees
 *
 * `due` and `standingBids` are the log's, at the checkpoint `H`. `inFlight` is
 * every live attempt this ledger has pinned from the address: one that landed
 * after `H` has already left the balance while the log still lists its debt,
 * and without the term the issuer would pause itself on its own payments. It
 * errs towards paying — an attempt that never landed is counted as if it
 * had — by at most what the deposit guard already let through.
 */
export function insolvent(input: {
  readonly sender: Address
  readonly balance: bigint
  readonly snapshot: WatchSnapshot
  readonly entries: readonly LedgerEntry[]
  /** Fees of the transactions this pass would newly pin from the address. */
  readonly fees: bigint
}): Breach | null {
  const { sender, balance, snapshot, entries, fees } = input
  if (sender !== CONSTANTS.MARKETPLACE_ADDRESS) return null
  let due = 0n
  for (const leg of snapshot.due) if (leg.owedBy === sender) due += leg.amount
  let inFlight = 0n
  for (const entry of entries) {
    if (entry.live !== null && entry.live.sender === sender) inFlight += entry.live.value + entry.live.fee
  }
  const owes = due + snapshot.standingBids + fees
  if (balance + inFlight >= owes) return null
  return {
    reason: 'INSOLVENT',
    key: null,
    detail:
      `${formatAddress(sender)} holds ${nim(balance)} NIM with ${nim(inFlight)} NIM in flight, and at checkpoint ${snapshot.checkpointHeight} ` +
      `the log has it owing ${nim(due)} NIM in debts and ${nim(snapshot.standingBids)} NIM in standing bids`,
  }
}
