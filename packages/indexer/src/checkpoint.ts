/**
 * The checkpoint builder — spec §8.1, with the §8.2 log hash it binds in.
 *
 * Every `CHECKPOINT_INTERVAL` blocks the indexer commits to the whole registry
 * in one 32-byte value:
 *
 * ```
 * commitment = keccak256(0x02 ‖ name_root ‖ prices ‖ pending ‖ unreserved ‖ log_hash ‖ height:u64-BE)
 * ```
 *
 * **Not one byte of that layout is computed here.** `@nimiqnames/core` owns it, down
 * to the tag bytes; this file decides only *when* a checkpoint is due, *which
 * state* is current at that height, and *which log lines* the hash covers.
 * That split is the point: a second implementation reproducing these roots has
 * to agree with `core`, and there is nothing in this package for it to
 * disagree with.
 *
 * ## Which heights
 *
 * Absolute multiples of `CHECKPOINT_INTERVAL` — `nextBoundaryAbove` in
 * `pipeline.ts` — never offsets from `LAUNCH_HEIGHT`. `LAUNCH_HEIGHT` is an
 * OPEN §3 value, and a checkpoint schedule that moves with a config value is a
 * schedule two operators can disagree about while both following the spec.
 * Multiples of 720 from block zero are the one reading that needs no
 * agreement. (They are also always macro blocks: the PoS genesis, 3,456,000,
 * is itself a multiple of 720, and 720 is 12 batches.)
 *
 * Every multiple from `LAUNCH_HEIGHT` onwards, `LAUNCH_HEIGHT` included when it
 * is itself a multiple. The state there is the empty state, but the checkpoint
 * is not empty: it commits the launch prices under the launch height, and it is
 * the base every later checkpoint is a delta from. Which boundaries a run
 * emits, and how the launch one is emitted exactly once across a restart, is
 * `pipeline.ts`'s to settle — see `PipelineOptions.lastCheckpointHeight`.
 *
 * ## The log hash, and why it streams
 *
 * §8.2 commits "the keccak256 of the file bytes from the first line through
 * the last message at or below the checkpoint height". That file only grows,
 * and re-hashing it at every checkpoint is quadratic in the length of the
 * chain — hours of pointless hashing over a backfill. {@link CheckpointBuilder}
 * keeps `core`'s {@link createLogHasher} running instead and digests a clone at
 * each boundary.
 *
 * The consequence: **the running hash is a position in the log, and it must
 * track exactly what the database has committed.** It is advanced only from
 * rows that are about to be written in the same transaction as the checkpoint
 * they feed, and on restart it is rebuilt by replaying the `log` table
 * ({@link CheckpointBuilder.seed}). A failed commit is fatal to the process for
 * this reason: the in-memory hash would be ahead of the table, and every later
 * checkpoint would be unreproducible.
 *
 * ## The unreserved set: a closed spec gap, and what the seam cost
 *
 * Through r15, §8.1 did **not** commit `state.unreserved` — the names whose `U`
 * has already fired. A pending `U` was committed (tag `0x09`); a fired one
 * vanished from the commitment, even though it is exactly what decides whether
 * a reserved name is registrable. Two indexers that disagreed about it derived
 * identical roots and different registries.
 *
 * r16 closed it (§8.1, tag `0x0A`) and `core` implements it. The seam this
 * package left for that day worked, and is worth keeping in mind for the next
 * one:
 *
 * - The fix was entirely `core`'s — a tenth tag and a fourth digest inside
 *   `checkpoint()`. Nothing in this file changed but the constant below,
 *   because the commitment arrives through {@link commitmentFor}'s arguments
 *   and nothing here assembles it.
 * - {@link COMMITMENT_LAYOUT} is written with every checkpoint row, and went to
 *   `2` in the commit that took the fix. Every stored checkpoint at layout `1`
 *   is knowably the output of a different function, not a mismatch to explain.
 * - `checkpoint.test.ts` pinned the gap with a test that *asserted* two states
 *   differing only in `unreserved` commit alike. It went red the day `core`
 *   landed `0x0A`, which is what it was for; it now asserts the opposite.
 */

import {
  checkpoint as coreCheckpoint,
  createLogHasher,
  type Checkpoint,
  type LogHasher,
  type NnsState,
} from '@nimiqnames/core'

import type { Logger } from './logger.js'
import type { BatchResult } from './pipeline.js'
import type { LogRow } from './rows.js'

export class CheckpointError extends Error {
  override readonly name = 'CheckpointError'
}

/**
 * Which §8.1 commitment function produced a row.
 *
 * - `1` — r15: name tree, prices, pending set, log hash, height.
 * - `2` — r16: the same, plus the unreserved set under tag `0x0A`.
 * - `3` — r17: the same six components, but the pending-`U` entry (tag
 *   `0x09`) commits its 20-byte `recipient` — zeros for a release, the
 *   awardee for an award — so every commitment over a state with a pending
 *   `U` changed value.
 * - `4` — r20: the recovery address is gone. The name leaf lost
 *   `recovery:20B` and the pending-transfer entry lost `via_recovery:u8`, so
 *   **every** commitment changed value, not only those over some particular
 *   pending item. Tag `0x06` (pending `R`) is retired and not reused.
 * - `5` — r26: the name leaf gained `evm:20B` between `target` and `expiry`
 *   (§6 `E`, 20 zero bytes when unset), so **every** commitment changed value
 *   again. Migration 008 adds the column; every layout-4 database is dropped
 *   and resynced, as every layout-3 database was at r20.
 * - `6` — the 2026-09-11 fold of r29: one governed price. The prices digest
 *   (tag `0x03`) is `fee_base ‖ commission_bp`, one field fewer, so **every**
 *   commitment changed value a third time. Migration 012 renames the column;
 *   every layout-5 database is dropped and resynced — and, for the first
 *   time, `Store.loadCursor` refuses the resume by this column rather than
 *   leaving it to the operator.
 *
 * Each bump changed the value of commitments the earlier function also
 * produced, so rows at different layouts at the same height are not comparable
 * and their difference is not a divergence. This column exists so that stays
 * legible in the data instead of being a mismatch nobody can explain.
 */
export const COMMITMENT_LAYOUT = 6

/** A checkpoint, as it goes into the `checkpoints` table. `BYTEA` wants `Buffer`. */
export type CheckpointRow = {
  height: number
  layout: number
  name_root: Buffer
  prices_root: Buffer
  pending_root: Buffer
  unreserved_root: Buffer
  log_hash: Buffer
  commitment: Buffer
}

export function checkpointRow(record: Checkpoint): CheckpointRow {
  return {
    height: record.height,
    layout: COMMITMENT_LAYOUT,
    name_root: Buffer.from(record.nameRoot),
    prices_root: Buffer.from(record.pricesRoot),
    pending_root: Buffer.from(record.pendingRoot),
    unreserved_root: Buffer.from(record.unreservedRoot),
    log_hash: Buffer.from(record.logHash),
    commitment: Buffer.from(record.commitment),
  }
}

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

/**
 * The one call site of `core.checkpoint` in this package.
 *
 * Everything the commitment covers arrives through `state` and `logHash`, so
 * when §8.1 grew a component — the unreserved set above, in r16 — this function
 * did not change and neither did anything calling it.
 *
 * @throws {CheckpointError} if the state is not current as of `height`.
 */
export function commitmentFor(state: NnsState, height: number, logHash: Uint8Array): Checkpoint {
  if (state.height !== height) {
    // `core.checkpoint` takes the height from the state, so a mismatch would
    // not fail — it would quietly commit at the wrong height.
    throw new CheckpointError(`state is at height ${state.height}, not at checkpoint height ${height}`)
  }
  return coreCheckpoint(state, logHash)
}

export interface CheckpointBuilderOptions {
  readonly logger: Logger
}

/**
 * Carries the running §8.2 log hash across batches and turns each crossed
 * boundary into a checkpoint.
 *
 * One instance per process. It is stateful by necessity — the log hash is a
 * fold over every line ever written — and that state is a mirror of the `log`
 * table, seeded from it on start.
 */
export class CheckpointBuilder {
  private readonly logger: Logger
  private readonly hasher: LogHasher = createLogHasher()
  /** Canonical position of the last appended row, so an out-of-order feed fails loudly. */
  private lastRef: readonly [number, number] = [-1, -1]
  private sealed = false

  constructor(options: CheckpointBuilderOptions) {
    this.logger = options.logger
  }

  /** Lines folded into the running hash. */
  get lines(): number {
    return this.hasher.lines
  }

  /** The §8.2 log hash through the last appended line. */
  get logHash(): Uint8Array {
    return this.hasher.digest()
  }

  /**
   * Replay one already-committed log row into the running hash, in canonical
   * order. The restart path: state is reloaded from the tables rather than
   * replayed, so the hash has to be rebuilt from the `log` table the same way.
   *
   * @throws {CheckpointError} after the first checkpoint has been built — seeding
   *   then would be splicing history under a commitment already made.
   */
  seed(row: LogRow): void {
    if (this.sealed) throw new CheckpointError('cannot seed the log hash after a checkpoint has been built')
    this.append(row)
  }

  /** Finish seeding and report what was loaded. */
  seeded(): void {
    this.logger.info('checkpoint.seeded', { lines: this.lines, logHash: this.logHash })
  }

  /**
   * Every checkpoint due inside one batch, in ascending height, and the log
   * hash advanced past the batch.
   *
   * Call once per batch, in batch order, **before** the batch is committed:
   * the returned rows belong in the same database transaction as the log rows
   * they cover.
   */
  buildForBatch(result: BatchResult): Checkpoint[] {
    this.sealed = true
    const records: Checkpoint[] = []
    let appended = 0

    for (const boundary of result.boundariesCrossed) {
      if (boundary.logRowsBefore < appended || boundary.logRowsBefore > result.logRows.length) {
        throw new CheckpointError(
          `boundary at ${boundary.height} claims ${boundary.logRowsBefore} log rows, ` +
            `outside [${appended}, ${result.logRows.length}]`,
        )
      }
      // Lines at or below this boundary are in the hash it commits; lines
      // above it are not. Canonical order makes that a prefix.
      while (appended < boundary.logRowsBefore) this.append(result.logRows[appended++] as LogRow)

      const record = commitmentFor(boundary.state, boundary.height, this.logHash)
      records.push(record)
      // The logger hex-encodes a `Uint8Array` itself; handing it the bytes
      // keeps one encoding rule in one place.
      this.logger.info('checkpoint.built', {
        height: record.height,
        layout: COMMITMENT_LAYOUT,
        names: boundary.state.names.size,
        logLines: this.lines,
        nameRoot: record.nameRoot,
        logHash: record.logHash,
        commitment: record.commitment,
      })
    }

    while (appended < result.logRows.length) this.append(result.logRows[appended++] as LogRow)
    return records
  }

  private append(row: LogRow): void {
    const ref: readonly [number, number] = [row.block_height, row.tx_index]
    const [lastHeight, lastIndex] = this.lastRef
    if (ref[0] < lastHeight || (ref[0] === lastHeight && ref[1] <= lastIndex)) {
      throw new CheckpointError(
        `log row ${ref[0]}:${ref[1]} follows ${lastHeight}:${lastIndex} — the log hash is order-dependent (§8.2)`,
      )
    }
    this.lastRef = ref
    this.hasher.append(logLineFromRow(row))
  }
}

/**
 * A `log` row back to its canonical §8.2 line.
 *
 * The columns *are* the canonical fields: `pipeline.ts` builds a row by
 * splitting `core.canonicalLogLine`, so joining them back is exact and no
 * normalisation happens twice. Anything else — re-deriving the line from a
 * transaction, say — would put a second copy of §8.2's formatting rules in
 * this package, and the committed hash is not a place for a second copy.
 */
export function logLineFromRow(row: LogRow): string {
  return [
    String(row.block_height),
    String(row.tx_index),
    row.tx_hash,
    row.sender,
    row.recipient,
    row.value,
    row.data,
    row.verdict,
  ].join(' ')
}
