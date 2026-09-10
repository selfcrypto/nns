/**
 * The §8.2 log, replayed through `core`'s own reducer.
 *
 * This is §8.4 Tier 1 verification pointed at one question: **what is owed,
 * and what has been settled.** It restates no protocol rule. A debt is a leg
 * appearing in `state.outstanding` across one call into `core` — a `reduce`,
 * or the final `advanceTo` — and a discharge is a leg disappearing from it
 * across an `M`; the commission cut is `core`'s `commissionOn`, applied by
 * `core` and never by this file.
 *
 * ## Why `outstanding` is diffed rather than the verdicts read
 *
 * Through r27 every leg was created by a verdict: a `REFUND` line, or a
 * winning `B`'s `OK`, carried its obligations and this file collected them.
 * r28 broke that for two legs and kept it for the rest — an auction's close
 * is a height effect (§7.3, `ORDER.AUCTION_CLOSE`), so `SALE_PROCEEDS` and
 * `COMMISSION` for the winning bid are created inside `advanceTo` with no
 * line to read them off, and the grace reset's refund of a standing bid is
 * the same shape. `outstanding` is the record either way, so the diff is
 * taken three times: across the advance to each line's height, across the
 * line itself, and once more across the advance to the checkpoint height
 * that ends the replay — an auction that closed in a quiet stretch still
 * surfaces, with no line after it. Which effects owe money stays `core`'s.
 *
 * ## Why the log is enough, and why finality never appears here
 *
 * A log line exists only for a message that survived §7.5 and was applied by an
 * indexer, and §7.2 step 3 forbids an indexer from advancing state past the
 * last finalised macro block. **Everything in the log is therefore already past
 * finality**, and this file needs no finality rule of its own — which is just
 * as well, because `core` has none to lend it (`lastFinalisedBatch` lives in
 * `packages/indexer`). The service that *issues* `M` transactions does need
 * one; that is its problem, at its own boundary, and not a constant to be
 * invented here.
 *
 * ## Why a full replay rather than reading the verdict tokens
 *
 * A refund obligation could be read straight off a `REFUND` line — sender,
 * value, and the address that owes it. A winning `B` could not: its two legs
 * are `price − commission` and `commission`, where the price comes from the
 * open `O` and the rate is `COMMISSION_RATE` **as in effect at the `B`'s own
 * height** (§6 `M`, §10.6) — and an auction's legs are not on any line at all.
 * Recovering either means tracking offers, auctions and governance — that is
 * a replay, minus the cross-check. So the replay is the cheap option as well
 * as the honest one.
 *
 * The cross-check it buys: every verdict this replay derives must equal the
 * token the log carries. §7.4 says rejected messages are logged with their
 * reason "so independent replays can confirm the rejection was correct rather
 * than merely observing an absence" — this is the code that does that, and a
 * mismatch means the served log is not the log these rules produce.
 */

import {
  addressEquals,
  advanceTo,
  parse,
  parseAddress,
  parseLogLine,
  reduce,
  refKey,
  verdictToken,
  type Address,
  type ChainTransaction,
  type NnsConfig,
  type NnsState,
  type Obligation,
  type TxRef,
  type Verdict,
} from '@nns/core'

export class ReplayError extends Error {
  override readonly name = 'ReplayError'
}

/**
 * An obligation together with where the replay first saw it.
 *
 * `at` is the line whose replay surfaced the leg, which is not always the
 * transaction that owes it (`obligation.ref`): a race loser's refund and a
 * below-price bid's refund surface on their own line; an outbid bidder's
 * refund surfaces on the *outbidding* `B`, keyed by the outbid bid's ref; an
 * auction close's two legs surface on the first line at or past the end
 * height, or — with no line after the close — nowhere, on the final advance
 * to the checkpoint height, which is `null` here. Diagnostic only: nothing
 * pays by it, and the key an `M` names is `obligation.ref`.
 */
export interface CreatedLeg {
  readonly obligation: Obligation
  readonly at: TxRef | null
}

/** An obligation and the `M` that discharged it. */
export interface SettledLeg {
  readonly obligation: Obligation
  /** The `M` transaction that paid it. */
  readonly settledAt: TxRef
  readonly settledBy: string
}

/**
 * An `M` that moved money and discharged nothing.
 *
 * §6 `M`: "An `M` matching no outstanding leg is accepted and changes nothing —
 * the debt it failed to discharge stays standing, which is how the log makes
 * any shortfall permanently visible." This is that shortfall, made countable.
 */
export interface UnmatchedSettlement {
  readonly at: TxRef
  readonly txHash: string
  readonly sender: Address
  readonly recipient: Address
  readonly value: bigint
  /** The transaction the `M` claimed to settle, from its payload. */
  readonly claims: TxRef
}

/** A line whose logged verdict is not the one these rules derive. */
/**
 * One line as the replay saw it: the state it reduced against (after the
 * height's effects, before the line), the state after, and the verdict. For
 * observers that keep their own books beside the reducer's — the §10.7
 * share in `share.ts` — without this file learning a single policy rule.
 */
export interface LineEvent {
  readonly tx: ChainTransaction
  readonly at: TxRef
  readonly before: NnsState
  readonly after: NnsState
  readonly verdict: Verdict
}

export interface VerdictMismatch {
  readonly at: TxRef
  readonly logged: string
  readonly replayed: string
}

export interface ReplayResult {
  /** Height of the last line in the log, or `null` for an empty log. */
  readonly lastLineHeight: number | null
  readonly lineCount: number
  readonly state: NnsState
  readonly created: readonly CreatedLeg[]
  readonly settled: readonly SettledLeg[]
  readonly outstanding: readonly CreatedLeg[]
  readonly unmatched: readonly UnmatchedSettlement[]
  readonly mismatches: readonly VerdictMismatch[]
}

/**
 * A log line, as `core.reduce` wants it.
 *
 * `executionResult`, `networkId` and `isReward` are not in the line and do not
 * need to be: §7.6 logs only what survived §7.5, so a line's mere existence is
 * the record that all three passed. Supplying the passing values re-states that
 * fact rather than assuming a new one — the alternative, threading them through
 * the log format, would widen the committed line for no reader.
 */
function toChainTransaction(line: string, config: NnsConfig): ChainTransaction {
  const fields = parseLogLine(line)
  return {
    blockNumber: fields.blockHeight,
    txIndex: fields.txIndex,
    hash: fields.txHash,
    sender: parseAddress(fields.sender),
    recipient: parseAddress(fields.recipient),
    value: fields.value,
    recipientData: fields.data,
    executionResult: true,
    networkId: config.networkId,
    isReward: false,
  }
}

/** The `(height, txIndex)` an `M` names in its payload, or `null` if it is not one. */
function settlementTarget(recipientData: string): TxRef | null {
  const parsed = parse(recipientData)
  if (!parsed.ok || parsed.message.type !== 'M') return null
  return { height: parsed.message.height, txIndex: parsed.message.txIndex }
}

const sameLeg = (a: Obligation, b: Obligation): boolean =>
  a.kind === b.kind && a.amount === b.amount && addressEquals(a.owedTo, b.owedTo) && addressEquals(a.owedBy, b.owedBy)

/**
 * Every leg in `after` that is not in `before` — a multiset difference per
 * ref, so two identical legs under one ref would both count.
 *
 * This is the one place a debt enters the replay's books. It does not ask
 * which verdict, which effect or which message created the leg, and must not:
 * a verdict's obligations, an outbid refund, a close's two legs and a grace
 * cancellation's refund all arrive here the same way, as `outstanding` growing.
 */
function newLegs(
  before: ReadonlyMap<string, readonly Obligation[]>,
  after: ReadonlyMap<string, readonly Obligation[]>,
): Obligation[] {
  const created: Obligation[] = []
  for (const [key, legs] of after) {
    const remaining = [...(before.get(key) ?? [])]
    for (const leg of legs) {
      const index = remaining.findIndex((other) => sameLeg(other, leg))
      if (index < 0) created.push(leg)
      else remaining.splice(index, 1)
    }
  }
  return created
}

/**
 * Which leg of `before` is missing from `after`.
 *
 * The reducer discharges exactly one leg per `M` and removes it by identity of
 * `(owedTo, owedBy, amount)`, so a positional diff of the two arrays finds it
 * without this file knowing that rule. Returns `null` when nothing was
 * discharged — the unmatched case.
 */
function dischargedLeg(
  before: readonly Obligation[] | undefined,
  after: readonly Obligation[] | undefined,
): Obligation | null {
  if (before === undefined) return null
  const remaining = [...(after ?? [])]
  for (const leg of before) {
    const index = remaining.findIndex(
      (other) => other.kind === leg.kind && other.amount === leg.amount && addressEquals(other.owedTo, leg.owedTo),
    )
    if (index < 0) return leg
    remaining.splice(index, 1)
  }
  return null
}

/**
 * Replay every line and account for every leg.
 *
 * @param lines the canonical §8.2 lines, in order, without terminators.
 * @param initial the state to start from — `core.initialState()`. Taken
 *   as a parameter rather than built here so a test can start from a staged
 *   state without this file growing a second way to make one.
 * @param through the height the log is current at — the checkpoint the
 *   server stamped it with. The state is advanced to it after the last line,
 *   which is what surfaces an auction that closed with no line after it. It is
 *   required, not defaulted to the last line's height: the difference between
 *   the two is exactly the window a close can fall into, and a caller that
 *   omitted it would be reporting "nothing owed" for a debt that is due.
 * @throws {ReplayError} if a line sits above `through` — a server that stamps
 *   a log with a checkpoint below its own last line is not serving the log
 *   that checkpoint commits.
 */
export function replayLog(
  lines: readonly string[],
  initial: NnsState,
  config: NnsConfig,
  through: number,
  observe?: (event: LineEvent) => void,
): ReplayResult {
  let state = initial
  const created: CreatedLeg[] = []
  const settled: SettledLeg[] = []
  const unmatched: UnmatchedSettlement[] = []
  const mismatches: VerdictMismatch[] = []
  let lastLineHeight: number | null = null

  for (const [index, line] of lines.entries()) {
    let tx: ChainTransaction
    try {
      tx = toChainTransaction(line, config)
    } catch (cause) {
      throw new ReplayError(
        `log line ${index + 1} is not a canonical §8.2 line: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    if (lastLineHeight !== null && tx.blockNumber < lastLineHeight) {
      throw new ReplayError(
        `log line ${index + 1} is at height ${tx.blockNumber}, below line ${index} at ${lastLineHeight} — the log is not in canonical order`,
      )
    }
    lastLineHeight = tx.blockNumber
    if (tx.blockNumber > through) {
      throw new ReplayError(
        `log line ${index + 1} is at height ${tx.blockNumber}, above the checkpoint height ${through} the log was served through`,
      )
    }

    const at: TxRef = { height: tx.blockNumber, txIndex: tx.txIndex }
    const target = settlementTarget(tx.recipientData)
    const key = target === null ? null : refKey(target)

    // The effects due at this line's height come first — a close, an expiry
    // — and `reduce` would take the same step itself, as a no-op once taken
    // here. It is taken here so the two halves can be diffed separately: an
    // `M` in the first block past a close pays a leg that the close created
    // in the same call, and one diff around the whole call would see neither
    // the debt nor its discharge, and report the `M` as paying nothing. The
    // guard keeps a line below the initial height — a log no honest indexer
    // writes — on `reduce`'s own path, where it is a verdict mismatch rather
    // than a thrown `ReducerError`.
    const advanced = tx.blockNumber > state.height ? advanceTo(state, tx.blockNumber) : state
    for (const obligation of newLegs(state.outstanding, advanced.outstanding)) {
      created.push({ obligation, at })
    }
    const before = key === null ? undefined : advanced.outstanding.get(key)

    const result = reduce(advanced, tx, config)
    for (const obligation of newLegs(advanced.outstanding, result.state.outstanding)) {
      created.push({ obligation, at })
    }
    state = result.state
    observe?.({ tx, at, before: advanced, after: state, verdict: result.verdict })

    const logged = parseLogLine(line).verdict
    const replayed = verdictToken(result.verdict)
    if (logged !== replayed) mismatches.push({ at, logged, replayed })

    // An `M` either removed a leg or moved money against nothing. Both are
    // findings; only the reducer decides which, and this reads its answer.
    if (target !== null && key !== null && result.verdict.kind === 'OK') {
      const leg = dischargedLeg(before, state.outstanding.get(key))
      if (leg === null) {
        unmatched.push({
          at,
          txHash: tx.hash,
          sender: tx.sender,
          recipient: tx.recipient,
          value: tx.value,
          claims: target,
        })
      } else {
        settled.push({ obligation: leg, settledAt: at, settledBy: tx.hash })
      }
    }
  }

  // The effects due between the last line and the checkpoint: a close, an
  // expiry that cancels an auction. `core` refuses to move backwards, and a
  // `through` below `initial.height` is that case — the initial state is
  // already past it.
  const advanced = advanceTo(state, through)
  for (const obligation of newLegs(state.outstanding, advanced.outstanding)) {
    created.push({ obligation, at: null })
  }
  state = advanced

  const outstanding: CreatedLeg[] = []
  for (const legs of state.outstanding.values()) {
    for (const obligation of legs) {
      const origin = created.find(
        (leg) => refKey(leg.obligation.ref) === refKey(obligation.ref) && sameLeg(leg.obligation, obligation),
      )
      // `created` is the only way into `outstanding`, so the origin exists;
      // `null` here would mean the identity `takeSnapshot` asserts is broken.
      outstanding.push({ obligation, at: origin?.at ?? null })
    }
  }
  outstanding.sort(
    (a, b) => a.obligation.ref.height - b.obligation.ref.height || a.obligation.ref.txIndex - b.obligation.ref.txIndex,
  )

  return {
    lastLineHeight,
    lineCount: lines.length,
    state,
    created,
    settled,
    outstanding,
    unmatched,
    mismatches,
  }
}
