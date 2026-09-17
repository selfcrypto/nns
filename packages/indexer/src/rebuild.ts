/**
 * A rules rebuild that replays this database's own §8.2 log (`tasks/14` D2).
 *
 * Every reducer revision is a rebuild (root `CLAUDE.md`, "Rebuild rule"). Until
 * now that meant dropping the database and walking the chain again from
 * `LAUNCH_HEIGHT` — ~1.5 h per box for 1.45M blocks at r28, a day and a half
 * per box per revision at mainnet's ~31.5M blocks a year, with the registry
 * down for the whole of it. Almost none of that time buys anything: the
 * overwhelming majority of batches carry no NNS message, and the ones that do
 * are already in the `log` table, in canonical order, with every field the
 * reducer consumes.
 *
 * ## What this is allowed to assume, and what it checks
 *
 * A rules rebuild is valid only for a **log-preserving** revision: one that
 * leaves the log's membership and its stored fields alone and moves only
 * verdicts and the state behind them. That is a fact about the revision, not
 * something derivable from the rows, so it is **declared** — `revision` must
 * be the build's own `SPEC_REVISION`, and the operator states it.
 *
 * The declaration is then checked as far as it can be, and the asymmetry in
 * how far that is matters. The log holds exactly the §7.5 survivors —
 * `IgnoredReason` is those five conditions and nothing else, and §7.6 drops an
 * `IGNORED` verdict alone — so a replay of a log-preserving revision must
 * produce the *same set of lines*, differing only in the token.
 * `Store.rebuildFromLog` compares line for line and rolls back naming the
 * first that does not match. So a revision that logs **fewer** lines is
 * caught here, cheaply and exactly: the line it now discards is left
 * unreproduced.
 *
 * A revision that logs **more** cannot be caught here at all, and neither can
 * an **omission** — a message that was on chain and never entered this log.
 * Both are the same blind spot in the end: the input is what was kept, so
 * nothing about what was not kept is in it. That is what the declaration is
 * for, and what `hybrid`'s sweep (`shadow.ts`) confirms afterwards from the
 * chain, scheduled by migration `013`'s columns.
 *
 * ## It needs no node
 *
 * The cursor stores `next_batch` beside `scanned_through`, and
 * `scanned_through` is the macro block that closes `next_batch - 1`. So
 * `genesisBlock = scanned_through - (next_batch - 1) × BLOCKS_PER_BATCH`
 * exactly, and `calibrate()`'s nine RPC calls are not needed. The rebuild is a
 * pure function of the database — which is what makes it seconds rather than
 * nearly-seconds, and what lets it run when the node is the thing being fixed.
 */

import { CONSTANTS, type NnsConfig } from '@nimiqnames/core'

import { BLOCKS_PER_BATCH, geometryFor, type ChainGeometry } from './chain.js'
import { hex } from './checkpoint.js'
import type { Logger } from './logger.js'
import { macroStops, replaySegments } from './replay.js'
import { nameRows, type LogRow } from './rows.js'
import type { NnsCandidate } from './scan.js'
import type { Cursor, Store } from './store.js'

export class RebuildError extends Error {
  override readonly name = 'RebuildError'
}

export interface RebuildOptions {
  readonly store: Store
  readonly logger: Logger
  readonly config: NnsConfig
  readonly launchHeight: number
  /**
   * The revision the operator declares log-preserving. Must equal this build's
   * `CONSTANTS.SPEC_REVISION`: the declaration is about the rules the rebuild
   * is *about to apply*, so a number that is not this build's describes some
   * other rebuild.
   */
  readonly revision: number
}

export interface RebuildResult {
  /** Highest height replayed — the cursor's `scanned_through`, unmoved. */
  readonly through: number
  /** Where the tail resumes, also unmoved. */
  readonly nextBatch: number
  readonly lines: number
  readonly verdictsRewritten: number
  readonly names: number
  /** The §8.1 commitment at the last boundary the replay crossed, bare hex. */
  readonly commitment: string | null
  /**
   * Which checkpoints the new rules moved — `firstMoved` is the height to
   * check against the last anchored root before anything is published.
   */
  readonly checkpoints: { readonly total: number; readonly moved: number; readonly firstMoved: number | null }
}

/**
 * Re-derive every verdict, root and derived row from the stored log.
 *
 * @throws {RebuildError} if the declaration does not match the build, if the
 *   database has never scanned a batch, or if the stored geometry is not
 *   self-consistent. Nothing is written in any of those cases.
 * @throws {StoreError} if the replay does not reproduce the stored log line
 *   for line — the declaration was wrong, and the transaction rolls back.
 */
export async function rebuildFromLog(options: RebuildOptions): Promise<RebuildResult> {
  const { store, logger, config, launchHeight, revision } = options

  if (revision !== CONSTANTS.SPEC_REVISION) {
    throw new RebuildError(
      `--log-preserving names revision ${revision}, this build implements ${CONSTANTS.SPEC_REVISION}. ` +
        'The declaration is about the rules this rebuild is about to apply, so the two cannot differ: ' +
        'either the wrong build is deployed, or the wrong revision was declared.',
    )
  }

  // Refuses on a moved §3 value, allows a moved §8.1 layout: this is what
  // replaces every checkpoint in the table, and a layout bump is one of the
  // things it exists for.
  const cursor = await store.loadCursor({ acrossLayouts: true })
  if (cursor === null) {
    throw new RebuildError(
      'this database has no cursor, so it has no log to replay and nothing derived to rebuild. ' +
        'An empty database is seeded by NNS_START_MODE (scratch, snapshot or hybrid), not by a rebuild.',
    )
  }

  const verification = (await store.loadVerification()) ?? {
    // A scratch database has no row (migration 009): its whole range was
    // derived from the chain, which is what `verifiedFrom = LAUNCH_HEIGHT`
    // says, and the rebuild is the first thing that has ever had to write it.
    verifiedFrom: launchHeight,
    bootstrapHeight: null,
    bootstrapSource: null,
    bootstrapLogHash: null,
    shadowThrough: null,
    rebuiltRevision: null,
    rebuiltThrough: null,
  }

  const geometry = geometryFromCursor(cursor)
  const launchBatch = Math.max(1, geometry.batchAt(launchHeight))
  const lastBatch = cursor.nextBatch - 1
  if (lastBatch < launchBatch) {
    throw new RebuildError(
      `the cursor is at batch ${cursor.nextBatch}, at or below the launch batch ${launchBatch} — ` +
        'this database has scanned nothing above LAUNCH_HEIGHT, so there is nothing to re-derive.',
    )
  }

  logger.info('rebuild.start', {
    revision,
    through: cursor.scannedThrough,
    nextBatch: cursor.nextBatch,
    launchHeight,
    genesisBlock: geometry.genesisBlock,
  })

  const candidates = await readStoredLog(store, config, launchHeight, cursor.scannedThrough)
  const stops = macroStops(launchBatch, lastBatch, geometry)

  let names = 0
  let commitment: string | null = null
  const outcome = await store.rebuildFromLog({
    revision,
    through: cursor.scannedThrough,
    verification,
    replay: async (segment) => {
      const replayed = await replaySegments({
        candidates,
        stops,
        config,
        logger,
        onStep: async (step) => {
          const boundary = step.result.boundariesCrossed[step.result.boundariesCrossed.length - 1]
          await segment({
            before: step.before,
            after: step.result.state,
            logRows: step.result.logRows,
            checkpoints: step.checkpoints,
            ...(boundary === undefined
              ? {}
              : { snapshot: { height: boundary.height, names: nameRows(boundary.state) } }),
          })
        },
      })
      names = replayed.state.names.size
      commitment = replayed.lastCheckpoint === undefined ? null : hex(replayed.lastCheckpoint.commitment)
      if (replayed.state.height !== cursor.scannedThrough) {
        throw new RebuildError(
          `the replay landed on height ${replayed.state.height}, not on the cursor's ${cursor.scannedThrough}`,
        )
      }
    },
  })

  logger.info('rebuild.done', {
    revision,
    through: cursor.scannedThrough,
    nextBatch: cursor.nextBatch,
    lines: outcome.lines,
    verdictsRewritten: outcome.verdictsRewritten,
    names,
    commitment,
    checkpoints: outcome.checkpoints,
  })

  return {
    through: cursor.scannedThrough,
    nextBatch: cursor.nextBatch,
    lines: outcome.lines,
    verdictsRewritten: outcome.verdictsRewritten,
    names,
    commitment,
    checkpoints: outcome.checkpoints,
  }
}

/**
 * The batch geometry, from the cursor alone.
 *
 * `scanned_through` is the macro block closing `next_batch - 1`, and a macro
 * block is `genesisBlock + batch × BLOCKS_PER_BATCH`. Two stored numbers pin
 * the anchor that `calibrate()` needs nine RPC calls and a binary search to
 * measure — because this database already did that measurement, and wrote both
 * halves of it down in one transaction.
 */
export function geometryFromCursor(cursor: Cursor): ChainGeometry {
  const genesisBlock = cursor.scannedThrough - (cursor.nextBatch - 1) * BLOCKS_PER_BATCH
  if (genesisBlock < 0) {
    throw new RebuildError(
      `the cursor is not self-consistent: scanned_through ${cursor.scannedThrough} at next_batch ` +
        `${cursor.nextBatch} puts the PoS genesis at ${genesisBlock}. One of the two was written by ` +
        'something other than a batch commit, and the geometry cannot be trusted.',
    )
  }
  return geometryFor(genesisBlock)
}

/**
 * Every stored log line as the candidate the reducer would have seen.
 *
 * The log carries the **effective** sender (§7.2, r25), so no attribution is
 * re-derived here and none can be: an HTLC's proof is not in the log, and
 * `core.effectiveSender` over a candidate with no proof returns the account,
 * which is the logged value. `fee` and `timestamp` are absent for the same
 * reason and are read by nothing downstream.
 */
async function readStoredLog(
  store: Store,
  config: NnsConfig,
  launchHeight: number,
  through: number,
): Promise<readonly NnsCandidate[]> {
  const candidates: NnsCandidate[] = []
  let previous: readonly [number, number] = [-1, -1]
  let broken: string | null = null
  await store.streamLogRows((row: LogRow) => {
    if (broken !== null) return
    if (row.block_height < launchHeight || row.block_height > through) {
      broken =
        `stored log line ${row.block_height}:${row.tx_index} is outside [${launchHeight}, ${through}] — ` +
        'the range this database claims to have scanned'
      return
    }
    const [lastHeight, lastIndex] = previous
    if (row.block_height < lastHeight || (row.block_height === lastHeight && row.tx_index <= lastIndex)) {
      // The query orders by the same pair, so this is a corrupt table rather
      // than a wrong query — and the §8.2 hash over the log is order-dependent.
      broken = `stored log line ${row.block_height}:${row.tx_index} follows ${lastHeight}:${lastIndex}`
      return
    }
    previous = [row.block_height, row.tx_index]
    candidates.push({
      blockNumber: row.block_height,
      txIndex: row.tx_index,
      hash: row.tx_hash,
      sender: row.sender,
      recipient: row.recipient,
      value: BigInt(row.value),
      fee: 0n,
      recipientData: row.data,
      networkId: config.networkId,
      executionResult: true,
      timestamp: 0,
    })
  })
  if (broken !== null) throw new RebuildError(broken)
  return candidates
}
