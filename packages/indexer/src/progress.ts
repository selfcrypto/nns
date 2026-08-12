/**
 * Run-level structured logging: height, verdict counts, checkpoint roots.
 *
 * The per-event lines already exist and are emitted where the event happens —
 * `scan.batch` in the scanner, `checkpoint.built` in the builder, `db.migrated`
 * in the migrator. What they cannot answer is the question an operator actually
 * has during a backfill, which is not "what happened in batch 920,861" but
 * **"where is it, and is it moving"**.
 *
 * That question is unanswerable from per-event lines for a specific reason: an
 * empty batch is the overwhelmingly common case, so every per-event line
 * demotes itself to `debug` when nothing happened. A replay from
 * `LAUNCH_HEIGHT` crosses hundreds of thousands of batches in which nothing
 * happens, and at the default level the process is therefore *silent for
 * hours* while working perfectly — indistinguishable, from outside, from a
 * process wedged on a dead socket.
 *
 * So this file adds one periodic line, `indexer.progress`, carrying the three
 * things the task names — the committed height, the verdict counts, the latest
 * checkpoint root — plus enough to answer "is it moving" (rate, batches
 * remaining, ETA). It is a heartbeat, and the counters in it are cumulative
 * over the run: a log shipper can aggregate them, and a human tailing the file
 * can read the last line alone and know the whole state of the run.
 *
 * ## Why the counts live here rather than in the database
 *
 * They are **operational**, not consensus-relevant. Nothing in this file feeds
 * a root, a log line, or a row; a heartbeat that missed a tick, or double
 * counted after a restart, would be a reporting bug and nothing more. The
 * authoritative counts are the `log` table's, which is a replayable artifact.
 * Keeping the two apart is deliberate: it means the emit policy below can be
 * tuned freely, and never with one eye on determinism.
 */

import type { Checkpoint } from '@nns/core'

import type { Logger } from './logger.js'
import type { BatchResult, VerdictCounts } from './pipeline.js'

/** At least one heartbeat per this much wall clock, while batches are arriving. */
const DEFAULT_INTERVAL_MS = 60_000

/**
 * …and at least one per this many batches, however fast they go by.
 *
 * A backfill runs far faster than the chain: without this, the interval alone
 * would report a 2,000-batch stride and a 20-batch stride as the same event.
 * With it, the line's cadence tracks *work done* during a backfill and *wall
 * clock* at the tail, which is the right axis in each case.
 */
const DEFAULT_EVERY_BATCHES = 2_000

export interface ProgressOptions {
  readonly logger: Logger
  /** Default {@link DEFAULT_INTERVAL_MS}. */
  readonly intervalMs?: number
  /** Default {@link DEFAULT_EVERY_BATCHES}. */
  readonly everyBatches?: number
  /** Defaults to `Date.now`. */
  readonly now?: () => number
  /**
   * The last finalised batch, if known — `Scanner.finalisedBatch`.
   *
   * A function rather than a value because it moves while the run does, and a
   * callback rather than a required argument because "how far behind" is a
   * nicety: everything else here is reportable without a node.
   */
  readonly target?: () => number | undefined
  /**
   * The height already committed when the run started, from the reloaded
   * state.
   *
   * Without it, every heartbeat before the first batch commits reports no
   * height at all — and that is precisely the run worth reporting on, because
   * a process that has committed nothing for ten minutes is either backfilling
   * a long gap or wedged, and the resume height is the first thing that tells
   * them apart. `batch` stays absent until one is committed: this run has
   * committed none, and saying otherwise would be a claim about durability
   * that is not this file's to make.
   */
  readonly startHeight?: number
}

/**
 * Accumulates what a run has done and emits a periodic line about it.
 *
 * One instance per process. Purely additive to the log — it neither replaces
 * nor suppresses any per-event line — except that the per-batch `reduce.batch`
 * line is emitted from here, because a batch's verdict counts and the running
 * totals are the same numbers and splitting them across two files is how they
 * drift apart.
 */
export class Progress {
  private readonly logger: Logger
  private readonly intervalMs: number
  private readonly everyBatches: number
  private readonly now: () => number
  private readonly target: (() => number | undefined) | undefined

  private readonly totals: VerdictCounts = { ok: 0, forfeit: 0, refund: 0, ignored: 0 }
  private batches = 0
  private logged = 0
  private checkpoints = 0
  private names = 0
  private batch: number | undefined
  private height: number | undefined
  private latest: Checkpoint | undefined

  private readonly startedAt: number
  private lastEmitAt: number
  private batchesAtLastEmit = 0

  constructor(options: ProgressOptions) {
    this.logger = options.logger
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.everyBatches = options.everyBatches ?? DEFAULT_EVERY_BATCHES
    this.now = options.now ?? Date.now
    this.target = options.target
    this.height = options.startHeight
    this.startedAt = this.now()
    this.lastEmitAt = this.startedAt
  }

  /**
   * Record one committed batch, and emit if a heartbeat is due.
   *
   * Call **after** the batch's database transaction has committed. What this
   * reports is what is durable — a line claiming a height the database does not
   * have is worse than no line at all, since it is exactly the claim an
   * operator would use to decide a restart is safe.
   */
  batchCommitted(batch: number, macroBlock: number, result: BatchResult, checkpoints: readonly Checkpoint[]): void {
    this.batches += 1
    this.batch = batch
    this.height = macroBlock
    this.logged += result.logRows.length
    this.checkpoints += checkpoints.length
    this.names = result.state.names.size
    this.totals.ok += result.counts.ok
    this.totals.forfeit += result.counts.forfeit
    this.totals.refund += result.counts.refund
    this.totals.ignored += result.counts.ignored
    // `buildForBatch` returns them in ascending height.
    const last = checkpoints.at(-1)
    if (last !== undefined) this.latest = last

    // The batch's own line. A batch in which nothing happened is the common
    // case by orders of magnitude; at `info` it would bury the ones that did.
    const line = {
      batch,
      height: macroBlock,
      stateHeight: result.state.height,
      names: result.state.names.size,
      logged: result.logRows.length,
      ...result.counts,
      boundaries: result.boundariesCrossed.length,
    }
    if (result.logRows.length > 0 || result.boundariesCrossed.length > 0) {
      this.logger.info('reduce.batch', line)
    } else {
      this.logger.debug('reduce.batch', line)
    }

    if (this.due()) this.emit()
  }

  /** Emit unconditionally — the end of a run, or a signal. */
  flush(reason: string): void {
    this.emit(reason)
  }

  private due(): boolean {
    if (this.batches - this.batchesAtLastEmit >= this.everyBatches) return true
    return this.now() - this.lastEmitAt >= this.intervalMs
  }

  private emit(reason?: string): void {
    const at = this.now()
    // Rate over the window since the last line, not over the run: at the tail a
    // run-average rate is dominated by the backfill that preceded it, and would
    // report "45 batches/s" about a process handling one per minute.
    const windowMs = at - this.lastEmitAt
    const windowBatches = this.batches - this.batchesAtLastEmit
    const rate = windowMs > 0 ? (windowBatches * 1000) / windowMs : undefined

    const remaining = this.remaining()
    this.logger.info('indexer.progress', {
      ...(reason === undefined ? {} : { reason }),
      batch: this.batch,
      height: this.height,
      names: this.names,
      ok: this.totals.ok,
      forfeit: this.totals.forfeit,
      refund: this.totals.refund,
      ignored: this.totals.ignored,
      logged: this.logged,
      checkpoints: this.checkpoints,
      ...(this.latest === undefined
        ? {}
        : { checkpointHeight: this.latest.height, commitment: this.latest.commitment }),
      batches: this.batches,
      ...(rate === undefined ? {} : { batchesPerSecond: round(rate, 2) }),
      ...(remaining === undefined ? {} : { behindBatches: remaining }),
      ...(remaining === undefined || rate === undefined || rate === 0
        ? {}
        : { etaSeconds: Math.round(remaining / rate) }),
      uptimeSeconds: Math.round((at - this.startedAt) / 1000),
    })

    this.lastEmitAt = at
    this.batchesAtLastEmit = this.batches
  }

  /** Batches between the last one committed and the last finalised one. */
  private remaining(): number | undefined {
    const target = this.target?.()
    if (target === undefined || this.batch === undefined) return undefined
    return Math.max(0, target - this.batch)
  }
}

function round(value: number, places: number): number {
  const scale = 10 ** places
  return Math.round(value * scale) / scale
}
