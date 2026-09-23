/**
 * Replaying candidates through `Pipeline` and `CheckpointBuilder` in segments.
 *
 * Two callers, one loop. `bootstrap.ts` replays a **peer's** §8.2 log to check
 * it against that peer's §8.1 commitment; `rebuild.ts` replays **this
 * database's own** log to re-derive every verdict under new rules. What they
 * share is the part that must not be written twice: state comes out of
 * `Pipeline` and roots come out of `CheckpointBuilder`, called exactly as the
 * scan loop calls them, so a replayed database is byte-identical to a scanned
 * one rather than merely equivalent.
 *
 * ## Why segments, and why the segment length is a memory bound
 *
 * A replay holds one `NnsState` per §8.1 boundary crossed inside a single
 * `applyBatch` call — that is how a checkpoint commits the state *at* the
 * boundary rather than at the end of the batch. So a segment's length bounds
 * how many registries are live at once, and nothing else: advancing more often
 * than §7.3 requires cannot change an outcome (`pipeline.ts`, "The advance
 * rule"), so a segment covering a thousand batches derives what a thousand
 * one-batch calls would.
 */

import { CONSTANTS, initialState, type Checkpoint, type NnsConfig, type NnsState } from '@nimiqnames/core'

import { BLOCKS_PER_BATCH, type ChainGeometry } from './chain.js'
import { CheckpointBuilder, logLineFromRow } from './checkpoint.js'
import type { Logger } from './logger.js'
import { Pipeline, type BatchResult } from './pipeline.js'
import type { NnsCandidate } from './scan.js'

export class ReplayError extends Error {
  override readonly name = 'ReplayError'
}

/**
 * Checkpoint boundaries per persisted segment — thirty-two registries live at
 * once, at most. With `CHECKPOINT_INTERVAL` one batch (r31 fold, 2026-09-23)
 * that is thirty-two batches a commit, about 16,000 commits over a year of
 * mainnet; the count is a rebuild's speed, never its result, and these
 * segments are not §8.8's — those are the log's archive format, unimplemented.
 */
export const SEGMENT_BOUNDARIES = 32

/** One stop of the replay: a height to land on, and the batch that follows it. */
export interface Stop {
  readonly throughHeight: number
  readonly nextBatch: number
}

export interface ReplayStep {
  readonly stop: Stop
  readonly before: NnsState
  readonly result: BatchResult
  readonly checkpoints: readonly Checkpoint[]
}

export interface ReplayOutcome {
  readonly state: NnsState
  readonly lastCheckpoint: Checkpoint | undefined
  /** How many log lines the replay produced. */
  readonly consumed: number
}

/** One macro-block stop per segment, covering `[fromBatch, toBatch]`. */
export function macroStops(fromBatch: number, toBatch: number, geometry: ChainGeometry): readonly Stop[] {
  const perSegment = Math.max(
    1,
    Math.ceil((SEGMENT_BOUNDARIES * CONSTANTS.CHECKPOINT_INTERVAL) / BLOCKS_PER_BATCH),
  )
  const stops: Stop[] = []
  for (let batch = fromBatch; batch <= toBatch; batch += perSegment) {
    const last = Math.min(batch + perSegment - 1, toBatch)
    stops.push({ throughHeight: geometry.macroBlockOf(last), nextBatch: last + 1 })
  }
  return stops
}

export interface ReplayOptions {
  readonly candidates: readonly NnsCandidate[]
  readonly stops: readonly Stop[]
  /**
   * The §8.2 lines the replay must reproduce, position by position — a peer's
   * served log.
   *
   * Omitted by a rules rebuild, and that omission is the whole difference
   * between the two callers: re-deriving verdicts under new rules is a replay
   * whose output is *expected* to differ from what is on record, so comparing
   * it against the old lines would refuse exactly the case it exists for. The
   * rebuild checks what it can instead — that the line **set** is unchanged
   * (`rebuild.ts`).
   */
  readonly sourceLines?: readonly string[]
  readonly config: NnsConfig
  readonly logger: Logger
  /**
   * The highest §8.1 boundary already committed, for a replay that does not
   * start at `initialState()`. Omitted, `Pipeline` starts one below
   * `LAUNCH_HEIGHT` so the launch boundary itself is emitted (§8.1).
   */
  readonly lastCheckpointHeight?: number
  readonly onStep?: (step: ReplayStep) => Promise<void>
}

/**
 * Run the candidates through `Pipeline` and `CheckpointBuilder`, stopping at
 * each of `stops` in turn.
 *
 * With `sourceLines`, every produced line is compared byte for byte against
 * the served one at the same position. The §8.1 commitment check a bootstrap
 * ends with subsumes that — a fabricated verdict changes the log hash and
 * therefore the commitment — but it reports *that* something is wrong where
 * this reports *which line*, and on a disagreement between two
 * implementations that is most of the answer.
 */
export async function replaySegments(options: ReplayOptions): Promise<ReplayOutcome> {
  const pipeline = new Pipeline(options.config, options.logger, {
    ...(options.lastCheckpointHeight === undefined
      ? {}
      : { lastCheckpointHeight: options.lastCheckpointHeight }),
  })
  const builder = new CheckpointBuilder({ logger: options.logger })

  let state: NnsState = initialState()
  let lastCheckpoint: Checkpoint | undefined
  let consumed = 0
  let next = 0

  for (const stop of options.stops) {
    const slice: NnsCandidate[] = []
    while (next < options.candidates.length) {
      const candidate = options.candidates[next] as NnsCandidate
      if (candidate.blockNumber > stop.throughHeight) break
      slice.push(candidate)
      next += 1
    }

    const result = pipeline.applyBatch(state, slice, stop.throughHeight)
    for (const row of result.logRows) {
      if (options.sourceLines !== undefined) {
        const produced = logLineFromRow(row)
        const served = options.sourceLines[consumed]
        if (produced !== served) {
          throw new ReplayError(
            `replaying the served log did not reproduce line ${consumed}:\n  served:  ${served ?? '(none)'}\n  replay:  ${produced}`,
          )
        }
      }
      consumed += 1
    }
    const checkpoints = builder.buildForBatch(result)
    lastCheckpoint = checkpoints[checkpoints.length - 1] ?? lastCheckpoint
    // `before` is this segment's entry state, exactly as the scan loop passes
    // the batch's: `diffState` against `initialState()` on the first segment
    // emits every row, which is what an emptied set of tables needs.
    await options.onStep?.({ stop, before: state, result, checkpoints })
    state = result.state
  }
  return { state, lastCheckpoint, consumed }
}
