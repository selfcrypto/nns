/**
 * The §8.2 log, replayed through `core`'s own reducer.
 *
 * This is §8.4 Tier 1 verification pointed at one question: **what is owed,
 * and what has been settled.** It restates no protocol rule. Obligations come
 * back from `core.reduce` as `Verdict.obligations`; discharges are observed as
 * legs disappearing from `state.outstanding` across an `M`; the commission cut
 * is `core`'s `commissionOn`, applied by `core` and never by this file.
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
 * height** (§6 `M`, §10.6). Recovering either means tracking offers and
 * governance — that is a replay, minus the cross-check. So the replay is the
 * cheap option as well as the honest one.
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
} from '@nns/core'

export class ReplayError extends Error {
  override readonly name = 'ReplayError'
}

/** An obligation together with the transaction whose line created it. */
export interface CreatedLeg {
  readonly obligation: Obligation
  /** The transaction that created the debt — identical to `obligation.ref`. */
  readonly at: TxRef
  readonly txHash: string
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
 */
export function replayLog(lines: readonly string[], initial: NnsState, config: NnsConfig): ReplayResult {
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

    const at: TxRef = { height: tx.blockNumber, txIndex: tx.txIndex }
    const target = settlementTarget(tx.recipientData)
    const key = target === null ? null : refKey(target)
    const before = key === null ? undefined : state.outstanding.get(key)

    const result = reduce(state, tx, config)
    state = result.state

    const logged = parseLogLine(line).verdict
    const replayed = verdictToken(result.verdict)
    if (logged !== replayed) mismatches.push({ at, logged, replayed })

    if (result.verdict.kind === 'OK' || result.verdict.kind === 'REFUND') {
      for (const obligation of result.verdict.obligations) {
        created.push({ obligation, at: obligation.ref, txHash: tx.hash })
      }
    }

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

  if (lastLineHeight !== null) state = advanceTo(state, lastLineHeight)

  const outstanding: CreatedLeg[] = []
  for (const legs of state.outstanding.values()) {
    for (const obligation of legs) {
      const origin = created.find(
        (leg) =>
          leg.obligation.ref.height === obligation.ref.height &&
          leg.obligation.ref.txIndex === obligation.ref.txIndex &&
          leg.obligation.kind === obligation.kind &&
          leg.obligation.amount === obligation.amount,
      )
      outstanding.push({ obligation, at: obligation.ref, txHash: origin?.txHash ?? '' })
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
