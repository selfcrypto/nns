/**
 * Reducer wiring (§7.2 step 2, §7.3, §7.6).
 *
 * `core.reduce` over the batch's candidates in canonical order, plus the
 * height-driven advance the spec makes an explicit MUST. **No protocol rules
 * live here** — every verdict comes back from `core`, and this file only
 * decides *when* to call it.
 *
 * ## The advance rule
 *
 * §7.3: "State advances on height as well as on messages: expiry, grace
 * release, timelock maturity, and governance activation all fire at a height
 * whether or not any transaction arrives. An implementation MUST apply due
 * effects **at least at every `CHECKPOINT_INTERVAL` boundary** — one that
 * advances only on messages passes almost every test and then commits a root
 * containing an expired name still `REGISTERED` at any checkpoint taken during
 * a quiet stretch."
 *
 * So `advanceTo` is called at every checkpoint boundary crossed, and again at
 * each batch's macro block so the persisted state has a definite height.
 * `reduce` advances to a transaction's own height internally, which is what
 * makes §7.3's "effects due at one height fire before that block's
 * transactions" hold without this file knowing the order of effects.
 *
 * Advancing *more often* than required can never change the outcome:
 * `advanceTo` applies every effect due at or below the height it is given, in
 * §7.3's fixed order, and applying them earlier than the next observation is
 * indistinguishable from applying them at it. Advancing *less* often is the
 * failure the spec paragraph describes.
 */

import {
  CONSTANTS,
  advanceTo,
  canonicalLogLine,
  parseAddress,
  reduce,
  type ChainTransaction,
  type NnsConfig,
  type NnsState,
  type Verdict,
} from '@nns/core'

import type { Logger } from './logger.js'
import type { LogRow } from './rows.js'
import type { NnsCandidate } from './scan.js'

export class PipelineError extends Error {
  override readonly name = 'PipelineError'
}

/** Verdict counts for one batch, for the structured log. */
export type VerdictCounts = {
  ok: number
  forfeit: number
  refund: number
  ignored: number
}

export interface BatchResult {
  readonly state: NnsState
  /** §8.2 rows, in canonical order. Only messages surviving §7.5 (§7.6). */
  readonly logRows: readonly LogRow[]
  readonly counts: VerdictCounts
  /** Checkpoint boundaries crossed while applying this batch. */
  readonly boundariesCrossed: readonly number[]
}

/**
 * The next checkpoint boundary strictly above `height`.
 *
 * Boundaries are absolute multiples of `CHECKPOINT_INTERVAL`, not offsets from
 * `LAUNCH_HEIGHT` — which is still OPEN in §3, and an anchor that moves with a
 * config value is an anchor two operators can disagree about. Only the *root*
 * heights are consensus-relevant, and those are the checkpoint builder's to
 * settle; for this file the convention only has to be at least as frequent as
 * §7.3 demands.
 */
export function nextBoundaryAbove(height: number): number {
  return (Math.floor(height / CONSTANTS.CHECKPOINT_INTERVAL) + 1) * CONSTANTS.CHECKPOINT_INTERVAL
}

/**
 * Apply every checkpoint boundary in `(state.height, target]`, then land on
 * `target` itself.
 */
export function advanceThroughBoundaries(
  state: NnsState,
  target: number,
  onBoundary?: (height: number) => void,
): NnsState {
  if (target <= state.height) return state
  let current = state
  for (
    let boundary = nextBoundaryAbove(current.height);
    boundary <= target;
    boundary = nextBoundaryAbove(current.height)
  ) {
    current = advanceTo(current, boundary)
    onBoundary?.(boundary)
  }
  return advanceTo(current, target)
}

/** `NnsCandidate` (RPC shapes) → `core.ChainTransaction` (protocol shapes). */
export function toChainTransaction(candidate: NnsCandidate): ChainTransaction {
  let sender
  let recipient
  try {
    sender = parseAddress(candidate.sender)
    recipient = parseAddress(candidate.recipient)
  } catch (cause) {
    // Not a §7.5 discard and not a §7.4 forfeit: the node handed us something
    // that is not a Nimiq address, which is a broken input rather than a
    // message with a verdict. Guessing either way would write a log line an
    // independent replay could not reproduce.
    throw new PipelineError(
      `transaction ${candidate.hash} at ${candidate.blockNumber}:${candidate.txIndex} has an unparseable address: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    )
  }
  return {
    blockNumber: candidate.blockNumber,
    txIndex: candidate.txIndex,
    hash: candidate.hash,
    sender,
    recipient,
    value: candidate.value,
    recipientData: candidate.recipientData,
    executionResult: candidate.executionResult,
    networkId: candidate.networkId,
  }
}

function logRow(tx: ChainTransaction, verdict: Verdict): LogRow {
  // Built from the canonical line rather than from the fields directly, so the
  // row and §8.2's bytes cannot drift apart: `canonicalLogLine` owns the
  // normalisation (lowercase hex, bare hash, compact addresses) and this
  // splits its output back into columns.
  const fields = canonicalLogLine(tx, verdict).split(' ')
  const [blockHeight, txIndex, hash, sender, recipient, value, data, token] = fields
  if (
    blockHeight === undefined ||
    txIndex === undefined ||
    hash === undefined ||
    sender === undefined ||
    recipient === undefined ||
    value === undefined ||
    data === undefined ||
    token === undefined
  ) {
    throw new PipelineError(`canonical log line did not yield eight fields: ${fields.length}`)
  }
  return {
    block_height: Number(blockHeight),
    tx_index: Number(txIndex),
    tx_hash: hash,
    sender,
    recipient,
    value,
    data,
    verdict: token,
  }
}

export class Pipeline {
  private readonly config: NnsConfig
  private readonly logger: Logger

  constructor(config: NnsConfig, logger: Logger) {
    this.config = config
    this.logger = logger
  }

  /**
   * Apply one batch: its candidates in canonical order, then the advance to
   * the batch's macro block.
   *
   * @param throughHeight the batch's macro block — the height the returned
   *   state is current as of.
   */
  applyBatch(state: NnsState, candidates: readonly NnsCandidate[], throughHeight: number): BatchResult {
    const counts: VerdictCounts = { ok: 0, forfeit: 0, refund: 0, ignored: 0 }
    const logRows: LogRow[] = []
    const boundariesCrossed: number[] = []
    const onBoundary = (height: number): void => {
      boundariesCrossed.push(height)
    }

    let current = state
    let previousKey = -1
    for (const candidate of candidates) {
      // Canonical order is the input's contract, and a violation here would
      // reorder the log — so it is checked rather than assumed.
      const key = candidate.blockNumber * 2 ** 20 + candidate.txIndex
      if (key <= previousKey) {
        throw new PipelineError(
          `candidates out of canonical order at ${candidate.blockNumber}:${candidate.txIndex} (§7.2 step 2)`,
        )
      }
      previousKey = key

      // Boundaries below this transaction's height fire before it (§7.3).
      current = advanceThroughBoundaries(current, candidate.blockNumber, onBoundary)

      const tx = toChainTransaction(candidate)
      const result = reduce(current, tx, this.config)
      current = result.state

      switch (result.verdict.kind) {
        case 'IGNORED':
          // §7.6: earns no log line. `canonicalLogLine` throws if asked.
          counts.ignored += 1
          this.logger.debug('reduce.ignored', {
            blockNumber: tx.blockNumber,
            txIndex: tx.txIndex,
            reason: result.verdict.reason,
          })
          continue
        case 'OK':
          counts.ok += 1
          break
        case 'FORFEIT':
          counts.forfeit += 1
          break
        case 'REFUND':
          counts.refund += 1
          break
      }
      logRows.push(logRow(tx, result.verdict))
    }

    // The batch is over whether or not anything happened in it. This is the
    // call the spec makes a MUST, and the one an implementation that advances
    // only on messages silently skips.
    current = advanceThroughBoundaries(current, throughHeight, onBoundary)

    return { state: current, logRows, counts, boundariesCrossed }
  }
}
