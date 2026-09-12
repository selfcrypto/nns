/**
 * The issuer: the one place in NNS that turns a debt into a transaction.
 *
 * **This file holds no key.** It signs through a {@link Wallet} it is handed —
 * `keys.ts` is the only module that reads key material, and only
 * `issue-main.ts` imports it. It also opens no database: the `Ledger` arrives
 * as a type-only import, so the whole issuing decision is testable against a
 * fake ledger and a fake node, which is how every claim below is checked.
 *
 * ## The order, and why it is not negotiable
 *
 * `dueForIssue()` → build the `M` → `pin()` → sign → send → `markSent()`.
 *
 * The plan must be **durable before anything is signed**. A database write and
 * a broadcast cannot be made atomic, so a crash between them is possible in any
 * design; what a design chooses is what that crash costs. Pinned first, the
 * recovery is to re-send *the pinned bytes verbatim*, and identical
 * re-broadcasts collapse to one transaction hash and land at most once
 * (`docs/rpc-reference.md` §4) — so the crash costs a stall and no money.
 * Signed first, the recovery would be to rebuild the transaction from a fresh
 * head, which produces a *different* valid transaction. That is the double
 * payment, and the ordering is the whole of the defence against it.
 *
 * {@link resumeOf} is the other half of that ordering: an entry left `CLAIMED`
 * with a `PINNED` attempt is re-sent from its stored columns and is never
 * re-planned. Nothing here recomputes a `validityStartHeight`.
 *
 * ## What decides *what* is owed — not this file
 *
 * Amounts, payees and payers come out of the ledger, which got them from
 * `core.reduce` through a verified log. The issuer restates no protocol rule:
 * the payload is `core.encodeSettlement`'s, the split is `core`'s, and §6 `M`'s
 * "sender MUST be `MARKETPLACE_ADDRESS` or `TREASURY_ADDRESS`" is satisfied by
 * paying from `owedBy` rather than by branching on the message type.
 *
 * ## Finality, once more, is inherited
 *
 * There is no confirmation depth here and no node is asked whether anything
 * landed. Every leg the ledger offers came from a `WatchSnapshot` at a stamped
 * checkpoint height, which §7.2 step 3 puts past the last finalised macro block
 * already. The node is read for exactly two things, both of which are chain
 * facts rather than protocol ones: the head (`validityStartHeight`) and the
 * sender balances (§11.5).
 *
 * ## §11.5, and the reason it is a pass-wide budget
 *
 * §11.5 rule 1 says read the sender's balance and compare it against
 * `value + fee` before signing. One leg at a time that is not enough: a pass
 * settling five legs from `MARKETPLACE_ADDRESS` would check each against the
 * *same* opening balance and cheerfully emit five transactions the address can
 * only fund three of — and the two that fail, fail by silence (§5.3). So the
 * balance is read once per sender per pass and drawn down as legs are issued,
 * and a sender that runs out stops issuing rather than skipping to a smaller
 * leg it can still afford. Debts are settled oldest first; queue-jumping on
 * affordability would make which creditor gets paid depend on arithmetic nobody
 * agreed to.
 */

import { CodecError, encodeSettlement, formatAddress, type Address, type NnsConfig } from '@nns/core'
import { METHOD_NOT_FOUND } from '@nns/indexer'

import type { Logger } from '@nns/indexer'
import type { Ledger, LedgerEntry, TransactionPlan } from './ledger.js'

export class IssueError extends Error {
  override readonly name = 'IssueError'
}

/** The slice of the RPC surface the issuer touches. `RpcClient` satisfies it. */
export interface IssuerRpc {
  call<T>(method: string, params?: readonly unknown[]): Promise<T>
}

/**
 * The signing capability, kept behind one method so this file never sees a key.
 *
 * The contract is narrow on purpose: make `sender` able to sign, run `body`,
 * and put it away again **whatever `body` does**. `keys.ts`'s implementation is
 * the node wallet — import, unlock, confirm, lock — and a test's is a recorder.
 */
export interface Wallet {
  /** Addresses this wallet can sign for. */
  readonly senders: readonly Address[]
  withSigningKey<T>(sender: Address, body: () => Promise<T>): Promise<T>
}

/** The ledger, as much of it as the issuer is allowed to touch. */
export type IssuerLedger = Pick<Ledger, 'entries' | 'dueForIssue' | 'pin' | 'markSent'>

/** One sender's §11.5 reading, taken once per pass. */
export interface SenderBalance {
  readonly sender: Address
  readonly balance: bigint
  /** `value + fee` summed over every leg this pass wanted to pay from it. */
  readonly wanted: bigint
  /** True when §11.5 rule 2's alert threshold is crossed — an alert, not a refusal. */
  readonly belowThreshold: boolean
}

/** What became of one leg in one pass. */
export type LegOutcome =
  /** Pinned, signed, broadcast and recorded. The only outcome that spends. */
  | { readonly kind: 'sent'; readonly key: string; readonly plan: TransactionPlan; readonly attemptNo: number; readonly txHash: string }
  /** A plan pinned by an earlier run, re-sent byte for byte. Never re-planned. */
  | { readonly kind: 'resent'; readonly key: string; readonly plan: TransactionPlan; readonly attemptNo: number; readonly txHash: string }
  /** Dry run: this is what `--send` would have done. Nothing was pinned. */
  | { readonly kind: 'planned'; readonly key: string; readonly plan: TransactionPlan }
  /** `core` refused to build the `M`. The debt stays standing and visible (§6 `M`). */
  | { readonly kind: 'unpayable'; readonly key: string; readonly amount: bigint; readonly reason: string }
  /** §11.5 rule 1: the sender cannot cover it. Nothing was pinned or signed. */
  | { readonly kind: 'underfunded'; readonly key: string; readonly sender: Address; readonly need: bigint; readonly left: bigint }
  /** A pinned attempt already past its window. It can never land; the ledger expires it. */
  | { readonly kind: 'stalled'; readonly key: string; readonly attemptNo: number; readonly expiresAfter: number }
  /** `--limit` stopped the pass before this leg. */
  | { readonly kind: 'deferred'; readonly key: string }
  /** Another leg in this pass is the same transaction, byte for byte. Next pass, at a new head. */
  | { readonly kind: 'collided'; readonly key: string; readonly withKey: string }
  /** The send, or the write after it, threw. See the class docs for what each costs. */
  | { readonly kind: 'failed'; readonly key: string; readonly stage: 'key' | 'pin' | 'send' | 'record'; readonly message: string }

export interface IssueReport {
  /** Chain head at planning time, and every new plan's `validityStartHeight`. */
  readonly head: number
  /** False for a dry run: nothing was pinned, signed or sent. */
  readonly send: boolean
  readonly balances: readonly SenderBalance[]
  readonly outcomes: readonly LegOutcome[]
}

export interface IssueOptions {
  readonly rpc: IssuerRpc
  readonly ledger: IssuerLedger
  readonly config: NnsConfig
  /** Absent for a dry run, and its absence is what makes a dry run one. */
  readonly wallet?: Wallet | undefined
  readonly feeLuna: bigint
  readonly expiryBlocks: number
  /** §11.5 rule 2's alert threshold, per sender. */
  readonly minBalance: bigint
  /** Maximum transactions this pass may broadcast. Unlimited when absent. */
  readonly limit?: number | undefined
  readonly logger?: Logger | undefined
}

// ── Pure derivations ────────────────────────────────────────────────────────

/**
 * The `M` for one leg, complete and ready to be pinned.
 *
 * `core.encodeSettlement` decides the payload, the recipient and the value; the
 * two things added here are chain facts, not protocol ones. `sender` is passed
 * to the builder so that the checks living there — a positive value, and a
 * sender that differs from its recipient — fail before the node hears anything.
 * Both would otherwise fail silently: a zero value is rejected outright, and a
 * self-transaction is accepted by the RPC and dropped by the network (§5.3).
 */
export function buildPlan(
  config: NnsConfig,
  entry: LedgerEntry,
  head: number,
  feeLuna: bigint,
  expiryBlocks: number,
): TransactionPlan {
  const built = encodeSettlement({
    height: entry.ref.height,
    txIndex: entry.ref.txIndex,
    payee: entry.owedTo,
    amount: entry.amount,
    sender: entry.owedBy,
  })
  return Object.freeze({
    ref: entry.ref,
    kind: entry.kind,
    sender: entry.owedBy,
    recipient: built.recipient,
    value: built.value,
    fee: feeLuna,
    data: built.data,
    validityStartHeight: head,
    expiresAfter: head + expiryBlocks,
  })
}

/**
 * A transaction's identity on the wire: everything the node hashes.
 *
 * Two legs with the same key are **one transaction**, not two — measured on
 * the era, 2026-09-12: the node answers the second `sendBasicTransaction` with
 * the first one's hash and one transfer lands. Every new plan in a pass is
 * pinned at the same `validityStartHeight` (the pass's head), so that is
 * reachable whenever one `G` owes one payee two equal amounts — which the
 * buyer's rebate makes ordinary rather than exotic: a surplus on a referred
 * `G` is a `REFUND` to the same buyer under the same ref (§10.5), and a buyer
 * who overpays by exactly the rebate owes twice the same bytes.
 */
const wireKey = (plan: TransactionPlan): string =>
  [plan.sender, plan.recipient, plan.value, plan.fee, plan.validityStartHeight, plan.data].join('|')

/**
 * The plan an earlier run pinned, read back out of the ledger unchanged.
 *
 * Every field comes from the stored columns. Rebuilding any of them — above all
 * `validityStartHeight` — would make the retry a second valid transaction
 * rather than the same one, which is the double payment this ordering exists to
 * prevent.
 */
export function resumeOf(entry: LedgerEntry): TransactionPlan {
  const live = entry.live
  if (live === null) throw new IssueError(`${entry.key} has no live attempt to resume`)
  return Object.freeze({
    ref: entry.ref,
    kind: entry.kind,
    sender: live.sender,
    recipient: live.recipient,
    value: live.value,
    fee: live.fee,
    data: live.data,
    validityStartHeight: live.validityStartHeight,
    expiresAfter: live.expiresAfter,
  })
}

/**
 * Where the expiry window came from, so the startup banner can say.
 *
 * `nodeWindow` is `null` only when the node has no `getPolicyConstants` — an
 * older build, or another operator's. That is the one case where the setting is
 * still required.
 */
export interface ExpiryWindow {
  readonly blocks: number
  readonly source: 'node' | 'override'
  readonly nodeWindow: number | null
}

/** `getPolicyConstants`, arity 0. Only one of its fourteen fields is read here. */
export async function readValidityWindow(rpc: IssuerRpc): Promise<number | null> {
  let constants: { transactionValidityWindow?: unknown }
  try {
    constants = await rpc.call<{ transactionValidityWindow?: unknown }>('getPolicyConstants')
  } catch (cause) {
    // A node without the method is a fallback, not a failure. Anything else —
    // bad credentials, a broken envelope — must still be loud.
    if ((cause as { code?: unknown }).code === METHOD_NOT_FOUND) return null
    throw cause
  }
  const window = constants?.transactionValidityWindow
  if (typeof window !== 'number' || !Number.isInteger(window) || window < 1) {
    throw new IssueError(
      `getPolicyConstants returned transactionValidityWindow ${JSON.stringify(window)} — expected a positive whole number of blocks`,
    )
  }
  return window
}

/**
 * How long a pinned `M` stays replaceable-only-after, resolved once at startup.
 *
 * **The node is the authority and the override may only lengthen.** An attempt
 * is replaceable only once it can no longer land, and it can land until
 * `validityStartHeight + transactionValidityWindow`; anything shorter declares
 * an attempt dead while it is still valid, pins a second one at a fresh height,
 * and lets both land. That is the double payment, and now that the window is
 * one call away it is refused rather than documented.
 *
 * Waiting *longer* than the chain requires is always safe — it costs a stall —
 * so the override survives for the operator who wants one.
 */
export async function resolveExpiryBlocks(rpc: IssuerRpc, override: number | null): Promise<ExpiryWindow> {
  const nodeWindow = await readValidityWindow(rpc)
  if (nodeWindow === null) {
    if (override === null) {
      throw new IssueError(
        'this node has no getPolicyConstants, so the transaction validity window cannot be read — ' +
          'set NNS_SETTLEMENT_EXPIRY_BLOCKS to it, or higher. Setting it lower than the chain\'s window is the double payment',
      )
    }
    return Object.freeze({ blocks: override, source: 'override', nodeWindow: null })
  }
  if (override === null) return Object.freeze({ blocks: nodeWindow, source: 'node', nodeWindow })
  if (override < nodeWindow) {
    throw new IssueError(
      `NNS_SETTLEMENT_EXPIRY_BLOCKS is ${override}, below the node's transactionValidityWindow of ${nodeWindow}. ` +
        `A pinned M can land until validityStartHeight + ${nodeWindow}; expiring it sooner pins a replacement while the first is still valid`,
    )
  }
  return Object.freeze({ blocks: override, source: 'override', nodeWindow })
}

/**
 * JSON has no bigint, and the RPC takes `value` and `fee` as numbers.
 *
 * Every luna amount in NNS fits — the entire supply is ~2.1 × 10^15 luna,
 * under `Number.MAX_SAFE_INTEGER` — but "fits by argument" is not a check, and
 * this is the one conversion in the system that turns money into a float.
 */
export function jsonLuna(amount: bigint, what: string): number {
  if (amount < 0n) throw new IssueError(`${what} is negative (${amount} luna)`)
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new IssueError(
      `${what} is ${amount} luna, past Number.MAX_SAFE_INTEGER — the RPC takes it as a JSON number and it would be rounded`,
    )
  }
  return Number(amount)
}

/** The `sendBasicTransactionWithData` parameter array, in the probed order (§4). */
export function sendParams(plan: TransactionPlan): readonly unknown[] {
  return [
    plan.sender,
    plan.recipient,
    plan.data,
    jsonLuna(plan.value, `${plan.kind} value`),
    jsonLuna(plan.fee, `${plan.kind} fee`),
    plan.validityStartHeight,
  ]
}

// ── The pass ────────────────────────────────────────────────────────────────

/** A leg with its plan, and how the plan came to exist. */
interface Work {
  readonly source: 'new' | 'resume'
  readonly entry: LedgerEntry
  readonly plan: TransactionPlan
  /** Set for a resume: the attempt already pinned. */
  readonly attemptNo: number | null
}

/**
 * Read the balance of every address this pass wants to spend from.
 *
 * One call per distinct sender, and the read is a `getAccountByAddress` — the
 * same method the §5.2 sequence uses to ask "funded yet?". It is deliberately
 * done for a dry run too: the precheck is the half of §11.5 that a rehearsal
 * can actually exercise.
 */
async function readBalances(rpc: IssuerRpc, senders: readonly Address[]): Promise<Map<Address, bigint>> {
  const balances = new Map<Address, bigint>()
  for (const sender of senders) {
    const account = await rpc.call<{ balance?: unknown }>('getAccountByAddress', [sender])
    const balance = account?.balance
    if (typeof balance !== 'number' || !Number.isInteger(balance) || balance < 0) {
      throw new IssueError(
        `getAccountByAddress(${formatAddress(sender)}) returned balance ${JSON.stringify(balance)} — expected a whole number of luna`,
      )
    }
    balances.set(sender, BigInt(balance))
  }
  return balances
}

/**
 * One issuance pass over whatever the ledger currently says is payable.
 *
 * It never applies a snapshot and never fetches a log: the frontier, the
 * amounts and the payees are the ledger's, which got them from a verified
 * `WatchSnapshot`. What this adds is the node, the key, and the ordering.
 *
 * **A failure is per leg, not per pass.** A node that refuses one send will
 * usually refuse them all, which is noisy — but the alternative is that one bad
 * leg (an expired plan, say) blocks every other creditor indefinitely, and a
 * settlement service whose failure mode is "pays nobody" is worse than one
 * whose failure mode is "reports ten errors". Every stage is recorded so the
 * caller can exit non-zero on any of them.
 */
export async function issuePass(options: IssueOptions): Promise<IssueReport> {
  const { rpc, ledger, config, wallet, feeLuna, expiryBlocks, minBalance, limit, logger } = options
  const send = wallet !== undefined

  const head = await rpc.call<number>('getBlockNumber')
  if (!Number.isInteger(head) || head < 0) {
    throw new IssueError(`getBlockNumber returned ${JSON.stringify(head)} — the head must be a whole block height`)
  }

  const outcomes: LegOutcome[] = []
  const work: Work[] = []

  // Resumes first. They are already committed, they are the cheapest thing in
  // the pass (no pin), and paying them before pinning anything new keeps the
  // sender's balance behind the promises it has already made.
  for (const entry of await ledger.entries()) {
    const live = entry.live
    if (entry.state !== 'CLAIMED' || live === null || live.state !== 'PINNED') continue
    if (live.expiresAfter < head) {
      // Past its window it can never land, so re-sending it is a wasted call and
      // a guaranteed node error. The ledger releases the leg when a stamped
      // checkpoint passes the same height — which is its rule, not this one's.
      outcomes.push({ kind: 'stalled', key: entry.key, attemptNo: live.attemptNo, expiresAfter: live.expiresAfter })
      continue
    }
    work.push({ source: 'resume', entry, plan: resumeOf(entry), attemptNo: live.attemptNo })
  }

  for (const entry of await ledger.dueForIssue()) {
    try {
      work.push({ source: 'new', entry, plan: buildPlan(config, entry, head, feeLuna, expiryBlocks), attemptNo: null })
    } catch (cause) {
      // `core` refusing to build is not an error to halt on: the debt stays
      // outstanding in the log, which is exactly how §6 `M` keeps a shortfall
      // permanently visible. A zero-luna commission and a payee that is its own
      // payer both land here.
      if (!(cause instanceof CodecError)) throw cause
      outcomes.push({ kind: 'unpayable', key: entry.key, amount: entry.amount, reason: cause.message })
    }
  }

  const senders = [...new Set(work.map((item) => item.plan.sender))]
  const balances = await readBalances(rpc, senders)

  const left = new Map(balances)
  const wanted = new Map<Address, bigint>()
  const exhausted = new Set<Address>()
  /** Wire identity → the leg that took it this pass. See `wireKey`. */
  const wires = new Map<string, string>()
  let broadcast = 0

  for (const item of work) {
    const { plan, entry } = item
    const need = plan.value + plan.fee
    wanted.set(plan.sender, (wanted.get(plan.sender) ?? 0n) + need)

    if (limit !== undefined && broadcast >= limit) {
      outcomes.push({ kind: 'deferred', key: entry.key })
      continue
    }

    // Checked before the pin, not at the send: pinning a plan nothing can sign
    // would leave the leg CLAIMED — the ambiguous state — for a reason that was
    // knowable up front.
    if (wallet !== undefined && !wallet.senders.includes(plan.sender)) {
      outcomes.push({
        kind: 'failed',
        key: entry.key,
        stage: 'key',
        message: `no key is configured for ${formatAddress(plan.sender)}, which §6 M requires as this leg's sender`,
      })
      continue
    }

    // Two legs that are the same transaction are one transaction, and the
    // second would be pinned to bytes the node has already taken — the leg
    // would then sit CLAIMED until its window expired, which is two hours of a
    // debt the operator believes is paid. Defer it instead: the next pass
    // plans at a later head, and different bytes land. Checked before the pin
    // for the same reason the key is (nothing ambiguous is committed) and
    // before the balance draw, so a deferred leg does not spend a budget it
    // never used.
    const wire = wireKey(plan)
    const taken = wires.get(wire)
    if (taken !== undefined) {
      outcomes.push({ kind: 'collided', key: entry.key, withKey: taken })
      continue
    }
    wires.set(wire, entry.key)

    // §11.5 rule 1, before anything is pinned and long before anything is
    // signed. A sender that has run out stops here rather than skipping ahead
    // to a leg it can still afford.
    const remaining = left.get(plan.sender) ?? 0n
    if (exhausted.has(plan.sender) || need > remaining) {
      exhausted.add(plan.sender)
      outcomes.push({ kind: 'underfunded', key: entry.key, sender: plan.sender, need, left: remaining })
      continue
    }
    left.set(plan.sender, remaining - need)

    if (!send) {
      outcomes.push({ kind: 'planned', key: entry.key, plan })
      continue
    }

    let attemptNo = item.attemptNo
    if (attemptNo === null) {
      try {
        attemptNo = await ledger.pin(plan)
      } catch (cause) {
        outcomes.push({ kind: 'failed', key: entry.key, stage: 'pin', message: messageOf(cause) })
        continue
      }
    }

    let txHash: string
    try {
      // The plan is durable now. Everything from here is re-doable: the same
      // bytes signed again produce the same hash and land at most once.
      txHash = await (wallet as Wallet).withSigningKey(plan.sender, () =>
        rpc.call<string>('sendBasicTransactionWithData', sendParams(plan)),
      )
      if (typeof txHash !== 'string' || txHash === '') {
        throw new IssueError(`sendBasicTransactionWithData returned ${JSON.stringify(txHash)} instead of a transaction hash`)
      }
    } catch (cause) {
      // CLAIMED, and the next pass re-sends these exact bytes. That is the
      // documented cost of this state: one stall, no money.
      outcomes.push({ kind: 'failed', key: entry.key, stage: 'send', message: messageOf(cause) })
      continue
    }
    broadcast += 1
    logger?.info('issue.sent', { key: entry.key, attemptNo, txHash, luna: plan.value.toString() })

    try {
      await ledger.markSent(plan.ref, plan.kind, attemptNo, txHash)
    } catch (cause) {
      // Broadcast but unrecorded: the attempt stays PINNED, the next pass
      // re-sends verbatim, the node collapses it to this same hash, and
      // `markSent` is idempotent for it. Reported because a persistent failure
      // here is a database problem, not a settlement one.
      outcomes.push({ kind: 'failed', key: entry.key, stage: 'record', message: messageOf(cause) })
      continue
    }

    outcomes.push({
      kind: item.source === 'resume' ? 'resent' : 'sent',
      key: entry.key,
      plan,
      attemptNo,
      txHash,
    })
  }

  const report: IssueReport = Object.freeze({
    head,
    send,
    balances: Object.freeze(
      senders.map((sender) => {
        const balance = balances.get(sender) ?? 0n
        return Object.freeze({
          sender,
          balance,
          wanted: wanted.get(sender) ?? 0n,
          belowThreshold: balance < minBalance,
        })
      }),
    ),
    outcomes: Object.freeze(outcomes),
  })
  return report
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause))

/** True when the pass hit something an operator has to act on. Drives the exit code. */
export function issueFailed(report: IssueReport): boolean {
  return report.outcomes.some((outcome) => outcome.kind === 'failed')
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** 1 NIM = 100,000 luna, and luna is `bigint`. Rendered, never computed on. */
function nim(luna: bigint): string {
  const whole = luna / 100_000n
  return `${whole.toString()}.${(luna % 100_000n).toString().padStart(5, '0')}`
}

export function describeIssue(report: IssueReport): readonly string[] {
  const out: string[] = []
  out.push(
    report.send
      ? `issuing at head ${report.head} — these transactions are real.`
      : `dry run at head ${report.head} — nothing is pinned, signed or sent. Pass --send to issue.`,
  )

  if (report.balances.length === 0) {
    out.push('no sender has anything to pay from; nothing was read.')
  } else {
    out.push('')
    for (const balance of report.balances) {
      out.push(
        `  ${formatAddress(balance.sender)}  holds ${nim(balance.balance)} NIM, this pass wants ${nim(balance.wanted)} NIM`,
      )
      if (balance.belowThreshold) {
        out.push(
          `    ALERT (§11.5): balance is below NNS_SETTLEMENT_MIN_BALANCE. This address has no income of its own — fund it.`,
        )
      }
    }
  }

  out.push('')
  if (report.outcomes.length === 0) {
    out.push('nothing to settle.')
    return out
  }

  for (const outcome of report.outcomes) {
    switch (outcome.kind) {
      case 'sent':
        out.push(`  ${outcome.key}  SENT      ${nim(outcome.plan.value)} NIM to ${formatAddress(outcome.plan.recipient)}  attempt ${outcome.attemptNo}  ${outcome.txHash}`)
        break
      case 'resent':
        out.push(`  ${outcome.key}  RE-SENT   ${nim(outcome.plan.value)} NIM to ${formatAddress(outcome.plan.recipient)}  attempt ${outcome.attemptNo} re-broadcast verbatim  ${outcome.txHash}`)
        break
      case 'planned':
        out.push(
          `  ${outcome.key}  WOULD PAY ${nim(outcome.plan.value)} NIM to ${formatAddress(outcome.plan.recipient)}` +
            `  from ${formatAddress(outcome.plan.sender)}  valid ${outcome.plan.validityStartHeight}–${outcome.plan.expiresAfter}`,
        )
        break
      case 'unpayable':
        out.push(`  ${outcome.key}  UNPAYABLE ${nim(outcome.amount)} NIM — ${outcome.reason}`)
        out.push('    The debt stays standing in the log, which is how a shortfall stays visible (§6 M).')
        break
      case 'underfunded':
        out.push(
          `  ${outcome.key}  UNFUNDED  needs ${nim(outcome.need)} NIM, ${formatAddress(outcome.sender)} has ${nim(outcome.left)} NIM left this pass`,
        )
        break
      case 'stalled':
        out.push(
          `  ${outcome.key}  STALLED   attempt ${outcome.attemptNo} expired at ${outcome.expiresAfter} and cannot land; awaiting a checkpoint above it`,
        )
        break
      case 'deferred':
        out.push(`  ${outcome.key}  DEFERRED  --limit reached`)
        break
      case 'collided':
        out.push(`  ${outcome.key}  COLLIDED  the same bytes as ${outcome.withKey} — one transaction, not two; paid next pass at a later head`)
        break
      case 'failed':
        out.push(`  ${outcome.key}  FAILED    at ${outcome.stage}: ${outcome.message}`)
        break
    }
  }
  return out
}
