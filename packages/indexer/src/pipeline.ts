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
 *
 * ## Which heights are boundaries
 *
 * §8.1: absolute multiples of `CHECKPOINT_INTERVAL`, **every one of them from
 * `LAUNCH_HEIGHT` onwards** — including `LAUNCH_HEIGHT` itself when it happens
 * to be such a multiple. That last case is the one this file used to get
 * wrong: `nextBoundaryAbove` is strictly above, the initial state is already
 * *at* `LAUNCH_HEIGHT`, and so a launch height of 58,204,800 got no checkpoint
 * at 58,204,800 while a launch height one block lower got one at the same
 * place. The schedule is supposed to be the one thing about checkpoints that
 * does not move with an OPEN §3 value.
 *
 * The launch boundary is not an empty formality: it commits the prices in
 * effect at launch and the (empty) name, pending and unreserved sets under the
 * launch height, which is the base every later checkpoint is a delta from.
 *
 * It is also the one boundary that can fall at a height the state has already
 * reached, so emitting it exactly once needs a memory of what has been
 * committed — {@link PipelineOptions.lastCheckpointHeight}, and
 * {@link Pipeline}'s own tracking of the boundaries it has handed out.
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

/**
 * A checkpoint boundary crossed inside a batch, with everything the checkpoint
 * builder needs to commit at it.
 *
 * The state is carried because a boundary generally falls *between* two
 * transactions of a batch, and §8.1 commits the state as of the boundary
 * height — not as of the batch's macro block. Reporting only the height, as
 * this field did before the checkpoint builder existed, left the caller no way
 * to recover the state that was current there.
 */
export interface BoundaryCrossing {
  /** An absolute multiple of `CHECKPOINT_INTERVAL`. Equals `state.height`. */
  readonly height: number
  readonly state: NnsState
  /**
   * How many of this batch's {@link BatchResult.logRows} are at or below
   * `height` — i.e. the prefix the §8.2 log hash covers at this checkpoint.
   *
   * It is a plain count rather than a filter because the rows are already in
   * canonical order and boundaries fire before the transactions that cross
   * them: every row emitted so far is at a height below this boundary, and
   * every later row is at or above it.
   */
  readonly logRowsBefore: number
}

export interface BatchResult {
  readonly state: NnsState
  /** §8.2 rows, in canonical order. Only messages surviving §7.5 (§7.6). */
  readonly logRows: readonly LogRow[]
  readonly counts: VerdictCounts
  /** Checkpoint boundaries crossed while applying this batch, in ascending order. */
  readonly boundariesCrossed: readonly BoundaryCrossing[]
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
 * Apply every checkpoint boundary in `(after, target]`, then land on `target`
 * itself.
 *
 * @param after the highest boundary already accounted for. Defaults to
 *   `state.height`, the ordinary case: whatever boundary sits exactly there was
 *   applied by the call that landed on it. A caller holding a state at a
 *   boundary it has *not* yet committed — only `LAUNCH_HEIGHT` at the start of
 *   a run — passes `state.height - 1` to get it. Anything lower is clamped,
 *   since `advanceTo` moves forward only and a boundary below `state.height`
 *   belongs to a call that already happened.
 */
export function advanceThroughBoundaries(
  state: NnsState,
  target: number,
  onBoundary?: (height: number, state: NnsState) => void,
  after: number = state.height,
): NnsState {
  if (target < state.height) return state
  let current = state
  for (
    let boundary = nextBoundaryAbove(Math.max(after, state.height - 1));
    boundary <= target;
    boundary += CONSTANTS.CHECKPOINT_INTERVAL
  ) {
    current = advanceTo(current, boundary)
    // After the advance, so the state handed out is the state *at* the
    // boundary — which is what §8.1 commits.
    onBoundary?.(boundary, current)
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

export interface PipelineOptions {
  /**
   * The highest checkpoint height already committed to the database. Boundaries
   * are emitted strictly above it.
   *
   * Omit it on a fresh start: the default, `launchHeight - 1`, makes
   * `LAUNCH_HEIGHT` itself the first boundary when it is a multiple of
   * `CHECKPOINT_INTERVAL` (§8.1).
   *
   * A resumed run must pass `store.latestCheckpoint()?.height`. Only one
   * boundary can fall at a height a reloaded state has already reached —
   * `LAUNCH_HEIGHT`, when the first batch's macro block *was* `LAUNCH_HEIGHT` —
   * and re-deriving it would not be a harmless duplicate: the running log hash
   * has since been reseeded with that block's own lines, so the second
   * derivation commits a different value at the same height and `Store` stops
   * the process as a divergence. Which is exactly what it should do; this is
   * how the run avoids asking.
   */
  readonly lastCheckpointHeight?: number
}

export class Pipeline {
  private readonly config: NnsConfig
  private readonly logger: Logger
  /**
   * Highest boundary handed to a caller, so no boundary is emitted twice. One
   * instance drives one run: the value starts from what the database already
   * holds and only ever moves up.
   */
  private lastBoundary: number

  constructor(config: NnsConfig, logger: Logger, options: PipelineOptions = {}) {
    this.config = config
    this.logger = logger
    this.lastBoundary = options.lastCheckpointHeight ?? config.launchHeight - 1
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
    const boundariesCrossed: BoundaryCrossing[] = []
    const onBoundary = (height: number, atBoundary: NnsState): void => {
      this.lastBoundary = height
      boundariesCrossed.push({ height, state: atBoundary, logRowsBefore: logRows.length })
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

      // Boundaries at or below this transaction's height fire before it (§7.3).
      current = advanceThroughBoundaries(current, candidate.blockNumber, onBoundary, this.lastBoundary)

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
    current = advanceThroughBoundaries(current, throughHeight, onBoundary, this.lastBoundary)

    return { state: current, logRows, counts, boundariesCrossed }
  }
}
