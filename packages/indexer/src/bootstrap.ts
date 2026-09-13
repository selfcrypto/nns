/**
 * Seeding an empty database from a peer's §8.2 log instead of from the chain
 * (`NNS_START_MODE=snapshot|hybrid`).
 *
 * A scratch backfill walks every batch from `LAUNCH_HEIGHT` — one RPC round
 * trip per 60 blocks, ~67 ms each measured against a colocated node, which is
 * about ten hours for a year of chain. Almost all of that time buys nothing:
 * the overwhelming majority of batches contain no NNS message at all, and the
 * few that do are already published, in canonical order, in the log every
 * resolver serves at `/log`.
 *
 * ## What is verified, and what is not
 *
 * The log arrives with two checks already applied by `source.ts` — canonical
 * form, and the served bytes hashing to the `x-nns-log-hash` the server stamps
 * — and bound to the §8.1 checkpoint at the height in
 * `x-nns-checkpoint-height`. This module adds the one that matters:
 *
 * **The log is replayed through `core.reduce`, and the §8.1 commitment that
 * replay produces must equal the one the peer published at that height.** All
 * six components, compared one at a time so a mismatch names the component.
 * Nothing the peer says about its own state is copied — only its log lines are
 * read, and every name, price, obligation and root here is derived locally.
 *
 * That is §8.4 **Tier 1** evidence and it is genuinely strong: it catches a
 * fabricated verdict, an edited payload, a reordered line, a wrong fee, and any
 * disagreement about the rules between the two implementations. It cannot catch
 * **omission** — a message that was on chain and is missing from both the log
 * and the state derived from it commits perfectly. Only a chain replay catches
 * that, which is what `hybrid` runs afterwards (`shadow.ts`) and what §8.4
 * calls Tier 3.
 *
 * A `snapshot` bootstrap therefore inherits the peer's blind spot for the
 * bootstrapped range, and that blind spot is *correlated*: operators who
 * bootstrap from the same peer share it, and it does not heal on its own. Hence
 * `verified_from` (migration 009) and its disclosure on `/params` — the answer
 * is not to forbid the mode but to stop it from claiming depth it does not have.
 *
 * ## Where the replay stops
 *
 * The peer's checkpoint height `H` is a macro block. The bootstrap persists
 * through `M`, the macro block of the batch **below** `H`'s, and hands the
 * scanner the cursor at `H`'s batch. So:
 *
 * - Everything persisted is at or below `M`, and `M < H` — so the whole
 *   persisted prefix is covered by the commitment that was checked at `H`.
 * - The last batch, `(M, H]`, is dropped from the log and re-derived from the
 *   chain by the ordinary scan, which is also what re-derives the checkpoint
 *   at `H`.
 * - The node needs history from `M` on, not from `LAUNCH_HEIGHT` — the horizon
 *   guard checks the resume batch, so a bootstrapped resolver can run against a
 *   node that has pruned. (`hybrid` needs the full history and says so at
 *   startup, before anything is written.)
 *
 * ## Why it replays rather than importing
 *
 * Every row is written through `Pipeline` and `CheckpointBuilder` — the same
 * two objects the scan loop uses, called the same way. A bootstrapped database
 * is byte-identical to a scratch one, not merely equivalent, and there is no
 * second derivation path to keep in step with the first. The only thing this
 * file owns is *which heights* the replay stops at.
 */

import {
  CONSTANTS,
  initialState,
  parseLogLine,
  type Checkpoint,
  type NnsConfig,
  type NnsState,
} from '@nimiqnames/core'

import { BLOCKS_PER_BATCH, calibrate, type ChainGeometry } from './chain.js'
import { CheckpointBuilder, COMMITMENT_LAYOUT, hex, logLineFromRow } from './checkpoint.js'
import type { Logger } from './logger.js'
import { Pipeline, type BatchResult } from './pipeline.js'
import { nameRows } from './rows.js'
import type { NnsCandidate, ScanRpc } from './scan.js'
import type { LogSource } from './peer.js'
import type { Store, Verification } from './store.js'

export class BootstrapError extends Error {
  override readonly name = 'BootstrapError'
}

/**
 * Checkpoint boundaries per persisted segment.
 *
 * The replay holds one `NnsState` per boundary crossed inside a single
 * `applyBatch` call — that is how §8.1 commits the state *at* the boundary
 * rather than at the end of the batch — so the segment length is a memory
 * bound, not a throughput knob. Thirty-two keeps a year of mainnet to a dozen
 * commits while never holding more than thirty-two registries at once.
 */
const SEGMENT_BOUNDARIES = 32

export interface BootstrapOptions {
  readonly store: Store
  /** Only `getBlockNumber`/`getBatchNumber`/`getBlockByNumber` are used, to calibrate. */
  readonly rpc: ScanRpc
  readonly logger: Logger
  readonly config: NnsConfig
  /**
   * The log and the §8.1 commitment it must reproduce, already fetched.
   *
   * Passed in rather than fetched here so this file is about replaying and
   * persisting and nothing else — which is also what lets a test hand it a log
   * without a network, and what let the anchor source be added without
   * touching a line of the replay.
   */
  readonly source: LogSource
  readonly launchHeight: number
}

export interface BootstrapResult {
  /** The peer checkpoint height the replay was verified against. */
  readonly checkpointHeight: number
  /** The highest macro block persisted — everything at or below it came from the log. */
  readonly throughHeight: number
  /** The batch the scanner resumes at. */
  readonly nextBatch: number
  /** The first block the scanner will read — the `verified_from` written. */
  readonly verifiedFrom: number
  readonly lines: number
  readonly names: number
  /** The §8.1 commitment reproduced at `checkpointHeight`, bare lowercase hex. */
  readonly commitment: string
}

/** One stop of the replay: a height to land on, and the batch that follows it. */
interface Stop {
  readonly throughHeight: number
  readonly nextBatch: number
}

/**
 * Fetch, verify and replay a peer's log into an empty database.
 *
 * @throws {BootstrapError} if the log cannot be bound to a checkpoint, if the
 *   replay does not reproduce that checkpoint, or if the peer has nothing to
 *   offer above `LAUNCH_HEIGHT`. Nothing is written in any of those cases: the
 *   whole verification runs before the first row.
 */
export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const { store, logger, config, source, launchHeight } = options
  const sourceUrl = source.origin
  const height = source.height

  logger.info('bootstrap.start', { source: sourceUrl, evidence: source.evidence, height })
  if (height % CONSTANTS.CHECKPOINT_INTERVAL !== 0) {
    throw new BootstrapError(
      `${sourceUrl} names checkpoint height ${height}, which is not a multiple of ` +
        `CHECKPOINT_INTERVAL (${CONSTANTS.CHECKPOINT_INTERVAL}) — §8.1 boundaries are absolute multiples`,
    )
  }
  if (source.components !== null && source.components.layout !== COMMITMENT_LAYOUT) {
    throw new BootstrapError(
      `${sourceUrl} commits at §8.1 layout ${source.components.layout}, this build derives layout ` +
        `${COMMITMENT_LAYOUT}. Rows at different layouts are the output of different functions and are not ` +
        'comparable — a difference between them is not a divergence and an agreement would not be evidence.',
    )
  }

  const geometry = await calibrate(options.rpc, logger)
  const launchBatch = Math.max(1, geometry.batchAt(launchHeight))
  const checkpointBatch = geometry.batchAt(height)
  if (checkpointBatch <= launchBatch) {
    throw new BootstrapError(
      `${sourceUrl} is only at height ${height} (batch ${checkpointBatch}), which is inside the launch batch ` +
        `${launchBatch} — there is nothing to bootstrap. Use NNS_START_MODE=scratch.`,
    )
  }
  const throughHeight = geometry.macroBlockOf(checkpointBatch - 1)

  const candidates = readLog(source.lines, config, launchHeight, height)

  // ── Pass 1: verify, writing nothing ──────────────────────────────────────
  const verified = await replay({
    candidates,
    stops: [...macroStops(launchBatch, checkpointBatch - 1, geometry), { throughHeight: height, nextBatch: checkpointBatch }],
    sourceLines: source.lines,
    config,
    logger,
  })
  const derived = verified.lastCheckpoint
  if (derived === undefined || derived.height !== height) {
    throw new BootstrapError(
      `the replay landed on height ${verified.state.height} without producing a checkpoint at ${height}`,
    )
  }
  if (verified.consumed !== candidates.length) {
    throw new BootstrapError(
      `the replay produced ${verified.consumed} log lines from ${candidates.length} served ones`,
    )
  }
  compareCheckpoint(derived, source)
  logger.info('bootstrap.verified', {
    source: sourceUrl,
    evidence: source.evidence,
    height,
    lines: candidates.length,
    names: verified.state.names.size,
    commitment: derived.commitment,
  })

  // ── Pass 2: the same replay, persisted, stopping one batch short ─────────
  //
  // Re-run rather than buffered: pass 1 is what decides whether any of this is
  // safe to write, and a version of it that accumulates every segment in memory
  // to flush afterwards would hold the whole backfill for a log this size.
  const verification: Verification = {
    verifiedFrom: geometry.firstBlockOf(checkpointBatch),
    bootstrapHeight: throughHeight,
    bootstrapSource: sourceUrl,
    bootstrapLogHash: hex(derived.logHash),
    shadowThrough: null,
  }
  let first = true
  const persisted = await replay({
    candidates,
    stops: macroStops(launchBatch, checkpointBatch - 1, geometry),
    sourceLines: source.lines,
    config,
    logger,
    onStep: async (step) => {
      const boundary = step.result.boundariesCrossed[step.result.boundariesCrossed.length - 1]
      await store.commitBatch({
        before: step.before,
        after: step.result.state,
        logRows: step.result.logRows,
        checkpoints: step.checkpoints,
        ...(boundary === undefined
          ? {}
          : { snapshot: { height: boundary.height, names: nameRows(boundary.state) } }),
        nextBatch: step.stop.nextBatch,
        scannedThrough: step.stop.throughHeight,
        // On the first segment only: the claim lands with the rows it
        // describes, so no crash can leave this database silent about where
        // its state came from.
        ...(first ? { verification } : {}),
      })
      first = false
    },
  })

  logger.info('bootstrap.done', {
    source: sourceUrl,
    checkpointHeight: height,
    throughHeight,
    nextBatch: checkpointBatch,
    verifiedFrom: verification.verifiedFrom,
    lines: persisted.consumed,
    names: persisted.state.names.size,
  })

  return {
    checkpointHeight: height,
    throughHeight,
    nextBatch: checkpointBatch,
    verifiedFrom: verification.verifiedFrom,
    lines: persisted.consumed,
    names: persisted.state.names.size,
    commitment: hex(derived.commitment),
  }
}

/**
 * Every §8.2 line as the candidate the reducer would have seen.
 *
 * The log carries the **effective** sender (§7.2, r25), so no attribution is
 * re-derived here and none can be: an HTLC's proof is not in the log, and
 * `core.effectiveSender` over a candidate with no proof returns the account,
 * which is the logged value. `fee` and `timestamp` are absent for the same
 * reason and are not read by anything downstream — `toChainTransaction` uses
 * neither.
 */
function readLog(
  lines: readonly string[],
  config: NnsConfig,
  launchHeight: number,
  checkpointHeight: number,
): readonly NnsCandidate[] {
  const candidates: NnsCandidate[] = []
  let previous: readonly [number, number] = [-1, -1]
  lines.forEach((line, index) => {
    let parsed
    try {
      parsed = parseLogLine(line)
    } catch (cause) {
      throw new BootstrapError(
        `log line ${index} is not a §8.2 line: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    if (parsed.blockHeight < launchHeight) {
      throw new BootstrapError(`log line ${index} is at height ${parsed.blockHeight}, below LAUNCH_HEIGHT`)
    }
    if (parsed.blockHeight >= checkpointHeight) {
      throw new BootstrapError(
        `log line ${index} is at height ${parsed.blockHeight}, at or above the checkpoint ` +
          `${checkpointHeight} it was served through — those bytes are not what that checkpoint commits`,
      )
    }
    const [lastHeight, lastIndex] = previous
    if (parsed.blockHeight < lastHeight || (parsed.blockHeight === lastHeight && parsed.txIndex <= lastIndex)) {
      throw new BootstrapError(
        `log line ${index} at ${parsed.blockHeight}:${parsed.txIndex} follows ${lastHeight}:${lastIndex} — ` +
          'the log is ordered by §5.2 and the hash over it is order-dependent',
      )
    }
    previous = [parsed.blockHeight, parsed.txIndex]
    candidates.push({
      blockNumber: parsed.blockHeight,
      txIndex: parsed.txIndex,
      hash: parsed.txHash,
      sender: parsed.sender,
      recipient: parsed.recipient,
      value: parsed.value,
      fee: 0n,
      recipientData: parsed.data,
      networkId: config.networkId,
      executionResult: true,
      timestamp: 0,
    })
  })
  return candidates
}

/** One macro-block stop per segment, covering `[fromBatch, toBatch]`. */
function macroStops(fromBatch: number, toBatch: number, geometry: ChainGeometry): readonly Stop[] {
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

interface ReplayStep {
  readonly stop: Stop
  readonly before: NnsState
  readonly result: BatchResult
  readonly checkpoints: readonly Checkpoint[]
}

interface ReplayOutcome {
  readonly state: NnsState
  readonly lastCheckpoint: Checkpoint | undefined
  /** How many log lines the replay produced. */
  readonly consumed: number
}

/**
 * Run the candidates through `Pipeline` and `CheckpointBuilder`, stopping at
 * each of `stops` in turn.
 *
 * Every produced line is compared byte for byte against the served one at the
 * same position. The §8.1 commitment check at the end subsumes this — a
 * fabricated verdict changes the log hash and therefore the commitment — but it
 * reports *that* something is wrong, where this reports *which line*, and on a
 * disagreement between two implementations that is most of the answer.
 */
async function replay(options: {
  readonly candidates: readonly NnsCandidate[]
  readonly stops: readonly Stop[]
  readonly sourceLines: readonly string[]
  readonly config: NnsConfig
  readonly logger: Logger
  readonly onStep?: (step: ReplayStep) => Promise<void>
}): Promise<ReplayOutcome> {
  const pipeline = new Pipeline(options.config, options.logger)
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
      const produced = logLineFromRow(row)
      const served = options.sourceLines[consumed]
      if (produced !== served) {
        throw new BootstrapError(
          `replaying the served log did not reproduce line ${consumed}:\n  served:  ${served ?? '(none)'}\n  replay:  ${produced}`,
        )
      }
      consumed += 1
    }
    const checkpoints = builder.buildForBatch(result)
    lastCheckpoint = checkpoints[checkpoints.length - 1] ?? lastCheckpoint
    // `before` is this segment's entry state, exactly as the scan loop passes
    // the batch's: `diffState` against `initialState()` on the first segment
    // emits every row, which is what a fresh database needs.
    await options.onStep?.({ stop, before: state, result, checkpoints })
    state = result.state
  }
  return { state, lastCheckpoint, consumed }
}

/**
 * The derived checkpoint against what the source says it should be.
 *
 * Two shapes, one rule. A source carrying all six components is compared one
 * at a time, so a mismatch names *which* — on a disagreement between two
 * implementations that is most of the answer. A source carrying only the
 * commitment (the §9 anchor: an `Anchored` event holds the root and the CID
 * digest, no individual roots) is compared on the commitment alone, which is
 * no weaker a check — the §8.2 log hash is one of the six inputs, so a single
 * wrong byte anywhere still moves it — only a quieter one when it fails.
 */
function compareCheckpoint(derived: Checkpoint, source: LogSource): void {
  const components: readonly (readonly [string, Uint8Array, string])[] =
    source.components === null
      ? [['commitment', derived.commitment, source.commitment]]
      : [
          ['nameRoot', derived.nameRoot, source.components.nameRoot],
          ['pricesRoot', derived.pricesRoot, source.components.pricesRoot],
          ['pendingRoot', derived.pendingRoot, source.components.pendingRoot],
          ['unreservedRoot', derived.unreservedRoot, source.components.unreservedRoot ?? ''],
          ['logHash', derived.logHash, source.components.logHash],
          ['commitment', derived.commitment, source.commitment],
        ]
  for (const [name, ours, theirs] of components) {
    if (hex(ours) === theirs) continue
    throw new BootstrapError(
      `replaying the log from ${source.origin} at height ${derived.height} did not reproduce the ` +
        `${source.evidence === 'anchor' ? 'anchored' : "peer's"} checkpoint: ` +
        `${name} is ${hex(ours)} here, ${theirs === '' ? '(absent)' : theirs} there. ` +
        'Nothing has been written. Either that log is not what that commitment covers, or the two ' +
        'implementations disagree about a rule' +
        (source.components === null
          ? ' — an anchor carries the commitment alone, so which of the six moved is not visible from here.'
          : ' — and which of the six components differs says which.'),
    )
  }
}
