/**
 * `hybrid`'s second half: re-deriving the bootstrapped range from the chain
 * while the ordinary tail keeps the resolver answering.
 *
 * `bootstrap.ts` verifies a peer's log against the §8.1 commitment that peer
 * published, which is §8.4 **Tier 1** evidence and catches every kind of lie
 * except one: a message that was on chain and appears in neither the log nor
 * the state derived from it. An omission commits perfectly, because the
 * commitment is over what was kept, not over what happened. §8.4 is explicit
 * that only a full replay from `LAUNCH_HEIGHT` closes that — Tier 3 — and this
 * is that replay, run in the background instead of before the service starts.
 *
 * ## What it actually compares
 *
 * A private `Pipeline`, a private `CheckpointBuilder` and a private
 * `NnsState`, all starting from `initialState()` at `LAUNCH_HEIGHT`, driven by
 * a second `Scanner` over the chain. **Nothing is written.** At every §8.1
 * boundary the commitment this derivation produces is compared against the row
 * already in `checkpoints`.
 *
 * That single comparison covers everything, because five of the six components
 * are roots over state and the sixth is the fold over every log line: an
 * omitted message changes the log hash from the block it was in onwards, and
 * any state it would have changed moves a root as well. There is no need to
 * diff log lines separately, and no way for a difference to hide.
 *
 * ## A mismatch is fatal, and that is the point
 *
 * `verifyFromChain` throws. `main.ts` aborts the run on it and the process
 * exits non-zero. An indexer that has proved its own stored state wrong must
 * not keep serving it while logging a warning nobody reads — the divergence
 * this whole design exists to catch has been caught, and the operator's next
 * step is a rebuild from scratch against a different peer, not a restart.
 *
 * ## Progress, not a resume point
 *
 * `shadow_through` is written on a throttle for the operator's benefit. It is
 * deliberately not a resume point: continuing a sweep from a height needs the
 * state at that height, and the only state at that height is the one the sweep
 * exists to derive independently. Reading it back from the tables would make
 * the check circular. A restart begins again at `LAUNCH_HEIGHT`.
 */

import { initialState, type NnsState } from '@nimiqnames/core'

import { calibrate } from './chain.js'
import { CheckpointBuilder, hex } from './checkpoint.js'
import type { Logger } from './logger.js'
import { Pipeline } from './pipeline.js'
import { Scanner, type ScanRpc } from './scan.js'
import type { Store } from './store.js'
import type { NnsConfig } from '@nimiqnames/core'

export class VerificationError extends Error {
  override readonly name = 'VerificationError'
}

/** How often `shadow_through` is written. Reporting only — see the file note. */
const PROGRESS_INTERVAL_MS = 30_000

export interface VerifyOptions {
  readonly rpc: ScanRpc
  readonly store: Store
  readonly logger: Logger
  readonly config: NnsConfig
  readonly networkId: number
  readonly launchHeight: number
  readonly pollIntervalMs: number
  /**
   * The tail's prefetch window, inherited. The sweep is the replay that
   * benefits most from it: it is a full re-derivation from `LAUNCH_HEIGHT` of a
   * range the chain finalised long ago, so every one of its fetches can be in
   * flight early.
   */
  readonly prefetch?: number
  /** The height the bootstrap asserted through — the sweep's last block. */
  readonly throughHeight: number
  /** Injectable for tests. */
  readonly now?: () => number
}

/**
 * Replay `[LAUNCH_HEIGHT, throughHeight]` from the chain and check every §8.1
 * commitment against the stored one.
 *
 * @returns when the range is verified, or early if the signal aborts — a
 *   shutdown mid-sweep leaves `verified_from` where it was, which is the honest
 *   answer.
 * @throws {VerificationError} on the first commitment that disagrees, or on a
 *   boundary the database has no row for.
 */
export async function verifyFromChain(options: VerifyOptions, signal: AbortSignal): Promise<void> {
  const { store, logger, config, launchHeight, throughHeight } = options
  const now = options.now ?? Date.now

  const geometry = await calibrate(options.rpc, logger)
  const stopAfterBatch = geometry.batchAt(throughHeight)
  logger.info('verify.start', {
    launchHeight,
    throughHeight,
    stopAfterBatch,
    batches: stopAfterBatch - Math.max(1, geometry.batchAt(launchHeight)) + 1,
  })

  const pipeline = new Pipeline(config, logger)
  const builder = new CheckpointBuilder({ logger })
  let state: NnsState = initialState()
  let checked = 0
  let reported = now()

  const scanner = new Scanner({
    rpc: options.rpc,
    logger,
    networkId: options.networkId,
    launchHeight,
    pollIntervalMs: options.pollIntervalMs,
    ...(options.prefetch === undefined ? {} : { prefetch: options.prefetch }),
    stopAfterBatch,
    onBatchComplete: async ({ macroBlock, candidates }) => {
      const result = pipeline.applyBatch(state, candidates, macroBlock)
      for (const derived of builder.buildForBatch(result)) {
        const stored = await store.checkpointAt(derived.height)
        if (stored === null) {
          throw new VerificationError(
            `re-deriving from the chain produced a checkpoint at ${derived.height} that this database does ` +
              'not hold. The bootstrapped range is missing a boundary, so what it committed to cannot be checked.',
          )
        }
        if (stored.commitment !== hex(derived.commitment)) {
          throw new VerificationError(
            `the chain does not agree with the log this database was bootstrapped from. At height ` +
              `${derived.height} a replay from LAUNCH_HEIGHT commits ${hex(derived.commitment)}; the stored row ` +
              `says ${stored.commitment}. Components — nameRoot ${hex(derived.nameRoot)} vs ${stored.nameRoot}, ` +
              `logHash ${hex(derived.logHash)} vs ${stored.logHash}. This database is not a replay of the chain ` +
              'and must be rebuilt from scratch; do not restart it.',
          )
        }
        checked += 1
      }
      state = result.state

      if (now() - reported >= PROGRESS_INTERVAL_MS) {
        reported = now()
        await store.recordShadowProgress(state.height)
        logger.info('verify.progress', {
          height: state.height,
          throughHeight,
          checkpointsChecked: checked,
          names: state.names.size,
        })
      }
    },
  })

  await scanner.run(signal)
  if (signal.aborted) {
    logger.info('verify.stopped', { height: state.height, checkpointsChecked: checked })
    return
  }

  await store.completeVerification(launchHeight)
  logger.info('verify.verified', {
    launchHeight,
    throughHeight,
    checkpointsChecked: checked,
    names: state.names.size,
  })
}
