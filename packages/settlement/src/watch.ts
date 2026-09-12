/**
 * The obligation watcher: what the log says is owed, and nothing else.
 *
 * `B` and `G` verdicts are what create most debts (§6 `B`, §7.4), and since
 * r28 an auction's close creates two with no verdict at all (§6 `A`, §7.3) —
 * but this file never looks for a `B`, a `G` or a close. It replays the log
 * through `core.reduce`, advances to the checkpoint height, and reads
 * `state.outstanding` — so *which* verdicts and effects owe money stays
 * `core`'s decision, and a message type that starts creating obligations
 * tomorrow is watched without a line changing here.
 *
 * No key, no broadcast, no database. The output is a list of legs and the
 * height they were true at; issuing against it is the next deliverable.
 *
 * ## Finality does not appear here, and that is the point
 *
 * §6 `M` says an operator SHOULD settle only past finalised macro blocks,
 * mirroring `FINALITY_RULE`. This package does not mirror it, because it does
 * not need to: §7.2 step 3 forbids an indexer from advancing state past the
 * last finalised macro block, so every height the API can stamp is already
 * final, and `/log` is stamped with a **checkpoint boundary** — one every
 * `CHECKPOINT_INTERVAL` (720) blocks against a finality horizon of about one
 * batch. The watcher therefore trails the chain by ~12 minutes where finality
 * asks for ~1, and settles far past it while owning no rule about it.
 *
 * What replaces the rule is the shape of {@link WatchSnapshot}: obligations and
 * the height they were observed at come out of **one** stamped fetch and cannot
 * be separated. There is no `confirmations` setting to tune, no local constant,
 * and no reason for one — a second expression of finality here could only
 * disagree with the first.
 *
 * ## Why `/log`, and not `/settlements`
 *
 * `/settlements` answers this question directly and cheaply, off the indexer's
 * own `settlements` table. It is served with no hash, no checkpoint binding and
 * no verdicts — fine for a dashboard, and not fine as a payment instruction.
 * `/log` carries `x-nns-log-hash`, binds to the §8.1 commitment at the stamped
 * height, and replays into the same obligations plus the cross-check that every
 * verdict in it is the verdict these rules derive. An input that money leaves on
 * should be verified at least as well as one an auditor merely reads, so the
 * watcher pays the extra fetch.
 *
 * It shares `source.ts` and `replay.ts` with the reconciler deliberately. That
 * does not weaken the audit: what `reconcile` catches is the operator not paying
 * or paying wrongly, and it catches that by observing the `M`s the service
 * actually broadcast — through the log, not through anything the service says
 * about itself. Sharing the derivation of *owed* is right, because owed is a
 * fact about the log rather than about the service.
 */

import { formatAddress, refKey, type Address, type Obligation, type ObligationKind } from '@nns/core'

import {
  createShareCollector,
  explainedSettlements,
  payoutWord,
  NO_SHARES,
  shareKey,
  type MispaidShare,
  type ReferralKind,
  type ShareResult,
  type UnpricedShare,
} from './share.js'
import type { RateTable } from './rates.js'

import { replayLog, type ReplayResult, type UnmatchedSettlement } from './replay.js'
import { fetchLatestCheckpoint, fetchLog, type Fetcher, type LogSnapshot } from './source.js'
import type { NnsConfig, NnsState } from '@nns/core'

export class WatchError extends Error {
  override readonly name = 'WatchError'
}

/**
 * A leg's stable identity: `<height>:<txIndex>:<KIND>`.
 *
 * The idempotency key the issuer and its ledger will settle by. `(ref, kind)`
 * is unique because every path a transaction can take owes at most one leg
 * per kind: a `B` on an offer owes one `REFUND` or a `SALE_PROCEEDS` and a
 * `COMMISSION`; a `B` that is a bid (r28) owes one `REFUND` — under
 * `WRONG_PRICE` on its own line, or by its own ref when it is outbid or the
 * grace reset cancels the auction — *or*, as the winning bid, the
 * `SALE_PROCEEDS` and `COMMISSION` the close creates, never both; a `G` owes
 * one `REFUND`. {@link takeSnapshot} asserts it rather than trusting it: were
 * `core` ever to create two legs of one kind for one transaction, the key
 * would silently collapse them and the issuer would underpay by exactly one
 * leg.
 */
export const obligationKey = (obligation: Obligation): string =>
  `${refKey(obligation.ref)}:${obligation.kind}`

/** One leg the log says is still owed, with the key it will be settled under. */
/**
 * What the ledger records and the issuer pays: `core`'s three kinds, plus the
 * two §10.7 payouts this package computes itself (`share.ts`) — the
 * referrer's share and the buyer's rebate. Kept as a union so a protocol leg
 * and a policy leg never share a type by accident.
 */
export type LedgerKind = ObligationKind | ReferralKind

export interface DueObligation {
  readonly key: string
  readonly kind: LedgerKind
  /** The transaction that created the debt — the `(height, tx_index)` an `M` names. */
  readonly ref: Obligation['ref']
  /** Sender of the `M` that discharges it: `MARKETPLACE_ADDRESS` or `TREASURY_ADDRESS` (§6 `M`). */
  readonly owedBy: Address
  /** Recipient of that `M`. */
  readonly owedTo: Address
  readonly amount: bigint
  /** Blocks between the debt's own height and the checkpoint this was observed at. */
  readonly ageBlocks: number
}

/**
 * Everything owed as of one checkpoint, and the evidence it rests on.
 *
 * `checkpointHeight` is not decoration: it is the settleable frontier, and the
 * only reason the issuer needs no finality rule. Every leg in `due` is at or
 * below it.
 */
export interface WatchSnapshot {
  readonly checkpointHeight: number
  readonly logHash: string
  readonly lineCount: number
  readonly due: readonly DueObligation[]
  readonly totalDue: bigint
  /**
   * `M`s already broadcast that discharged nothing (§6 `M`). Not a reason to
   * stop watching — the debts they missed are in `due`, still owed — but an
   * operator alarm, and the issuer's policy about halting on one is its own.
   */
  readonly unmatched: readonly UnmatchedSettlement[]
  /**
   * Referral payments that disagree with this watcher's own rate table
   * (§10.7). The operator paid the right payee for the right registration and
   * the wrong figure — the debt is not in `due` (it was paid, after a
   * fashion), so this list is the only place it shows.
   */
  readonly mispaidShares: readonly MispaidShare[]
  /** Referral payments this watcher's table does not price. Empty for an operator holding their own rows. */
  readonly unpricedShares: readonly UnpricedShare[]
}

export type WatchResult =
  /** The server's newest checkpoint is the one already seen. Nothing was refetched. */
  | { readonly kind: 'unchanged'; readonly checkpointHeight: number }
  /** The server has no checkpoint yet — an indexer short of its first boundary. */
  | { readonly kind: 'no-checkpoint' }
  | { readonly kind: 'snapshot'; readonly snapshot: WatchSnapshot }

export interface Watcher {
  /** One cycle: cheap height check, then a verified refetch only if it moved. */
  poll(): Promise<WatchResult>
  /** The checkpoint height of the last snapshot taken, or `null` before the first. */
  readonly lastSeen: number | null
}

export interface WatcherOptions {
  readonly apiUrl: string
  readonly config: NnsConfig
  readonly fetcher: Fetcher
  /** `core.initialState()`, taken as a parameter for the same reason `replayLog` does. */
  readonly initial: NnsState
  /** The §10.7 rate table. Without one the watcher pays no shares and reports none. */
  readonly rates?: RateTable | undefined
}

/**
 * Turn a verified log snapshot into the due set.
 *
 * Exported separately from {@link createWatcher} so the derivation can be
 * tested without a transport, and so a caller holding a `LogSnapshot` from
 * somewhere else cannot skip it.
 *
 * Three conditions refuse outright, all of them meaning *these bytes are not a
 * safe basis for paying anyone*:
 *
 * - **A verdict disagrees with the replay.** §7.4 logs rejections so an
 *   independent replay can confirm them; when the confirmation fails, the
 *   amounts derived alongside are derived from a log these rules did not
 *   produce. The reconciler already calls this unsound and exits 1.
 * - **`created ≠ settled + outstanding`.** A broken balance is a bug in the
 *   replay, and its symptom would be a wrong due set.
 * - **The log is not bound to its checkpoint.** `reconcile` has
 *   `--no-checkpoint-binding` because an auditor may face a server that
 *   genuinely pruned the height it stamped. There is no matching honest reason
 *   to *pay* against bytes on the serving party's word alone, so the watcher
 *   has no such flag and asserts the binding instead.
 */
export function takeSnapshot(log: LogSnapshot, replay: ReplayResult, shares: ShareResult = NO_SHARES): WatchSnapshot {
  if (!log.boundToCheckpoint) {
    throw new WatchError(
      `the log at checkpoint ${log.checkpointHeight} is not bound to that checkpoint — the watcher will not derive a payment from bytes on the serving party's word alone`,
    )
  }
  const [first] = replay.mismatches
  if (first !== undefined) {
    throw new WatchError(
      `${replay.mismatches.length} verdict(s) in the log disagree with the replay — first at ${refKey(first.at)}: ` +
        `log says ${first.logged}, replay says ${first.replayed}. Nothing is owed by a log these rules did not produce`,
    )
  }

  const created = new Map<string, bigint>()
  for (const leg of replay.created) {
    const key = obligationKey(leg.obligation)
    created.set(key, (created.get(key) ?? 0n) + leg.obligation.amount)
  }

  const due: DueObligation[] = []
  const seen = new Set<string>()
  let totalDue = 0n
  for (const leg of replay.outstanding) {
    const key = obligationKey(leg.obligation)
    if (seen.has(key)) {
      throw new WatchError(
        `two outstanding legs share the key ${key} — (ref, kind) is the issuer's idempotency key and must be unique; ` +
          `this means core now creates more than one leg of a kind per transaction and the issuer would underpay`,
      )
    }
    seen.add(key)
    due.push({
      key,
      kind: leg.obligation.kind,
      ref: leg.obligation.ref,
      owedBy: leg.obligation.owedBy,
      owedTo: leg.obligation.owedTo,
      amount: leg.obligation.amount,
      ageBlocks: Math.max(0, log.checkpointHeight - leg.obligation.ref.height),
    })
    totalDue += leg.obligation.amount
  }

  // `created = settled + outstanding`, per leg. The reconciler asserts it per
  // (address, kind); here it is per key, because a key is what will be paid.
  const settledByKey = new Map<string, bigint>()
  for (const leg of replay.settled) {
    const key = obligationKey(leg.obligation)
    settledByKey.set(key, (settledByKey.get(key) ?? 0n) + leg.obligation.amount)
  }
  for (const [key, amount] of created) {
    const outstandingAmount = due.find((leg) => leg.key === key)?.amount ?? 0n
    if (amount !== (settledByKey.get(key) ?? 0n) + outstandingAmount) {
      throw new WatchError(
        `leg ${key} does not balance: created ${amount}, settled ${settledByKey.get(key) ?? 0n}, outstanding ${outstandingAmount} luna`,
      )
    }
  }

  // The §10.7 payouts, beside the reducer's legs. `created = settled +
  // outstanding` holds for them by construction (`share.ts` keeps one map),
  // and their keys cannot collide with a protocol leg's: a `G` that owes a
  // referral was `OK`, and an `OK` `G` creates no `REFUND`. The two payouts
  // of one `G` differ in the kind, which is in the key.
  for (const leg of shares.outstanding) {
    const key = shareKey(leg)
    if (seen.has(key)) throw new WatchError(`two outstanding payouts share the key ${key} — one G owes at most one payout per kind`)
    seen.add(key)
    due.push({
      key,
      kind: leg.kind,
      ref: leg.ref,
      owedBy: leg.owedBy,
      owedTo: leg.payee,
      amount: leg.amount,
      ageBlocks: Math.max(0, log.checkpointHeight - leg.ref.height),
    })
    totalDue += leg.amount
  }

  due.sort((a, b) => a.ref.height - b.ref.height || a.ref.txIndex - b.ref.txIndex || a.kind.localeCompare(b.kind))

  // An `M` that paid a referrer discharged nothing in the reducer's books and
  // is accounted for in the share's — settled, unpriced or mispaid. Only what
  // none of the three explains is a finding.
  const explained = explainedSettlements(shares)
  const unmatched = replay.unmatched.filter((item) => !explained.has(refKey(item.at)))

  return Object.freeze({
    checkpointHeight: log.checkpointHeight,
    logHash: log.logHash,
    lineCount: replay.lineCount,
    due: Object.freeze(due),
    totalDue,
    unmatched: Object.freeze(unmatched),
    mispaidShares: shares.mispaid,
    unpricedShares: shares.unpriced,
  })
}

/**
 * A watcher over one API.
 *
 * It remembers the last checkpoint it saw so it can refuse two things that a
 * stateless fetch cannot notice:
 *
 * - **A rewind.** A checkpoint height going backwards means a different server,
 *   a rebuilt database, or a rolled-back one. `M`s already broadcast may have
 *   left the log, which would make their debts look outstanding again — the one
 *   way this design can produce a double payment.
 * - **A fork at a height already seen.** Same checkpoint height, different log
 *   hash. §8.5's business, and not something to keep polling through. It is
 *   caught on the *cheap* leg of the poll, which is why `/checkpoints/latest`
 *   is read for its hash as well as its height: were the height alone compared,
 *   the one case a skipped refetch hides would be the one worth catching.
 *
 * That memory is in process and is deliberately not persistence: the ledger is
 * the third deliverable and its own database. A restart forgets the last height
 * and refetches once, which costs one request and no correctness — the due set
 * is a fact about the log, not about what this process has seen. What a restart
 * genuinely cannot recover is an `M` broadcast but not yet in a checkpoint;
 * that gap is what the ledger exists to close, not this.
 */
export function createWatcher(options: WatcherOptions): Watcher {
  const { apiUrl, config, fetcher, initial, rates } = options
  let lastSeen: number | null = null
  let lastHash: string | null = null

  return {
    get lastSeen() {
      return lastSeen
    },

    async poll(): Promise<WatchResult> {
      const latest = await fetchLatestCheckpoint(apiUrl, fetcher)
      if (latest === null) return { kind: 'no-checkpoint' }

      if (lastSeen !== null && latest.height < lastSeen) {
        throw new WatchError(
          `${apiUrl} went backwards: newest checkpoint is ${latest.height}, last seen was ${lastSeen}. ` +
            `An M already broadcast can drop out of a rewound log and its debt reappear as outstanding — refusing to watch further`,
        )
      }
      if (lastSeen !== null && latest.height === lastSeen) {
        if (latest.logHash !== lastHash) {
          throw new WatchError(
            `${apiUrl} now commits a different log at checkpoint ${lastSeen}: was ${lastHash}, now ${latest.logHash}. ` +
              `A checkpoint that changes without advancing is a fork, not an update`,
          )
        }
        return { kind: 'unchanged', checkpointHeight: latest.height }
      }

      const log = await fetchLog(apiUrl, fetcher)
      if (lastSeen !== null && log.checkpointHeight < lastSeen) {
        throw new WatchError(
          `${apiUrl} stamped /log with checkpoint ${log.checkpointHeight} after reporting ${latest.height} as latest and ${lastSeen} previously`,
        )
      }

      const collector = rates === undefined ? null : createShareCollector(rates)
      const replay = replayLog(log.lines, initial, config, log.checkpointHeight, collector?.observe)
      const snapshot = takeSnapshot(log, replay, collector?.result() ?? NO_SHARES)
      lastSeen = snapshot.checkpointHeight
      lastHash = snapshot.logHash
      return { kind: 'snapshot', snapshot }
    },
  }
}

/** 1 NIM = 100,000 luna, and luna is `bigint`. Rendered, never computed on. */
function nim(luna: bigint): string {
  const whole = luna / 100_000n
  return `${whole.toString()}.${(luna % 100_000n).toString().padStart(5, '0')}`
}

/** Width of `formatAddress` output: 36 characters in nine groups, eight spaces. */
const ADDRESS_COLUMN = 44

export function describeSnapshot(snapshot: WatchSnapshot): readonly string[] {
  const out: string[] = []
  out.push(
    `log through checkpoint ${snapshot.checkpointHeight}, ${snapshot.lineCount} lines, hash ${snapshot.logHash}`,
  )
  out.push(`bound: the checkpoint at ${snapshot.checkpointHeight} commits this exact log`)
  out.push('')

  if (snapshot.due.length === 0) {
    out.push('nothing is owed as of this checkpoint.')
  } else {
    out.push(`${snapshot.due.length} obligation(s) due, ${nim(snapshot.totalDue)} NIM in total:`)
    out.push(
      ['key'.padEnd(26), 'pay to'.padEnd(ADDRESS_COLUMN), 'from'.padEnd(ADDRESS_COLUMN), 'NIM'.padStart(14), 'age'].join(' '),
    )
    for (const leg of snapshot.due) {
      out.push(
        [
          leg.key.padEnd(26),
          formatAddress(leg.owedTo).padEnd(ADDRESS_COLUMN),
          formatAddress(leg.owedBy).padEnd(ADDRESS_COLUMN),
          nim(leg.amount).padStart(14),
          `${leg.ageBlocks}b`,
        ].join(' '),
      )
    }
    out.push('')
    out.push(
      'Every leg above is at or below the checkpoint height, which an indexer cannot advance past the last finalised macro block (§7.2). No confirmation depth is applied because none is needed.',
    )
  }

  if (snapshot.mispaidShares.length > 0) {
    out.push('')
    out.push(`${snapshot.mispaidShares.length} referral payment(s) DISAGREE with the rate table (§10.7):`)
    for (const item of snapshot.mispaidShares) {
      out.push(
        `  ${refKey(item.paidAt)} ${payoutWord(item.leg.kind)} for ${refKey(item.leg.ref)} ${item.leg.name} via ${item.leg.referrer}: table says ${nim(item.leg.amount)}, paid ${nim(item.paid)} NIM, tx ${item.paidBy}`,
      )
    }
  }

  if (snapshot.unpricedShares.length > 0) {
    const own = snapshot.unpricedShares.filter((item) => item.reason === 'self-referral')
    const noRate = snapshot.unpricedShares.filter((item) => item.reason === 'no-rate')
    for (const [heading, group] of [
      [`${own.length} SELF-REFERRAL payment(s) the table prices at nothing (§10.7):`, own],
      [`${noRate.length} referral payment(s) this table does not price:`, noRate],
    ] as const) {
      if (group.length === 0) continue
      out.push('')
      out.push(heading)
      for (const item of group) {
        out.push(
          `  ${refKey(item.paidAt)} ${payoutWord(item.kind)} for ${refKey(item.referral.ref)} ${item.referral.name} via ${item.referral.referrer}, ${nim(item.paid)} NIM, tx ${item.paidBy}`,
        )
      }
    }
  }

  if (snapshot.unmatched.length > 0) {
    out.push('')
    out.push(`${snapshot.unmatched.length} settlement(s) already broadcast discharged nothing (§6 M):`)
    for (const item of snapshot.unmatched) {
      out.push(`  ${refKey(item.at)} claims ${refKey(item.claims)}, ${nim(item.value)} NIM, tx ${item.txHash}`)
    }
  }

  return out
}
