/**
 * The scan loop (spec §7.1, §7.2 steps 1–3, §7.5).
 *
 * Walks batches from `LAUNCH_HEIGHT` with `getTransactionsByBatchNumber`,
 * filtering on the `NNS1` data prefix. That is the entire discovery
 * mechanism — no `getTransactionsByAddress`, so any history node without a
 * transaction index can host an indexer.
 *
 * **No protocol rules live here.** The four §7.5 conditions applied below are
 * discovery filters, not validity decisions: each drops a transaction that is
 * not an NNS message at all. Everything a message's *validity* depends on is
 * `core`'s, and `core.reduce` re-applies §7.5 itself — this pass exists so we
 * do not carry the whole chain into memory, not to pre-empt it.
 *
 * This is the chain-facing half: nothing is persisted, and the reducer is not
 * wired. Surviving transactions are handed to `onCandidate` and logged.
 *
 * ## Fetches are concurrent, applies are not
 *
 * A replay's cost is round trips: measured 2026-09-16, one batch fetch at a
 * time runs at 502/min over the tunnel and 43,548/min on the LAN, and the
 * overwhelming majority of those batches carry no NNS message at all. So
 * `prefetch` batches may be in flight at once — 7,878/min at a window of 16
 * over the same tunnel — but they are *consumed* in
 * strict ascending order, one `onBatchComplete` at a time, because that
 * callback commits a batch and moves the cursor with it. Nothing about the
 * derived bytes depends on the window: the node answers a batch identically
 * whatever else is in flight, and a window of `1` is the serial loop.
 */

import { CONSTANTS, rankMessages } from '@nimiqnames/core'

import { type ChainGeometry, calibrate, lastFinalisedBatch } from './chain.js'
import { assertHistoryHorizon } from './horizon.js'
import type { Logger } from './logger.js'
import { RpcError, RpcTransportError, type RpcClient, type RpcTransaction } from './rpc.js'

/** `NNS1` as lowercase hex — `recipientData` arrives hex-encoded (§5.1). */
export const PROTOCOL_PREFIX_HEX = Buffer.from(CONSTANTS.PROTOCOL_ID, 'ascii').toString('hex')

export class ScanError extends Error {
  override readonly name = 'ScanError'
}

/**
 * A transaction that carries the `NNS1` prefix and survived §7.5, stamped
 * with its canonical rank (§5.2 hash order, derived by `core.rankMessages`).
 *
 * Addresses stay in `NQ…` string form: turning them into `core`'s `Address`
 * is the reducer wiring's job, and a malformed one is a verdict question, not
 * a discovery question.
 */
export interface NnsCandidate {
  readonly blockNumber: number
  readonly txIndex: number
  readonly hash: string
  readonly sender: string
  readonly recipient: string
  readonly value: bigint
  readonly fee: bigint
  /** Lowercase hex, prefix included. */
  readonly recipientData: string
  readonly networkId: number
  readonly executionResult: boolean
  readonly timestamp: number
  /**
   * §7.2 attribution (r25): the sender's account type and the transaction
   * proof, passed through so core can attribute an HTLC-sent message to its
   * authorizing key. Optional because an RPC shape may omit them — absence
   * degrades to account attribution, never to an error.
   */
  readonly senderType?: number
  readonly proof?: string
}

// A type alias rather than an interface: only aliases get the implicit index
// signature that lets a summary be passed straight to the logger.
export type BatchSummary = {
  readonly batch: number
  readonly firstBlock: number
  readonly macroBlock: number
  readonly returned: number
  readonly candidates: number
  readonly droppedFailedExecution: number
  readonly droppedWrongNetwork: number
  readonly droppedBeforeLaunch: number
  readonly droppedNotNns1: number
}

export function hasProtocolPrefix(recipientData: string | undefined): boolean {
  return recipientData !== undefined && recipientData.toLowerCase().startsWith(PROTOCOL_PREFIX_HEX)
}

/**
 * The scan loop's whole view of the node. Structural on purpose: it is the
 * complete list of what tailing costs, and it keeps the tests honest by
 * making a fake node a real implementation rather than a cast.
 */
export type ScanRpc = Pick<
  RpcClient,
  | 'isConsensusEstablished'
  | 'getBlockNumber'
  | 'getBatchNumber'
  | 'getTransactionsByBatchNumber'
  | 'getBlockByNumber'
>

/** Everything one scanned batch produced. */
export interface CompletedBatch {
  readonly batch: number
  readonly firstBlock: number
  readonly macroBlock: number
  /** Survivors of §7.5, in canonical order (§5.2). */
  readonly candidates: readonly NnsCandidate[]
  readonly summary: BatchSummary
}

/**
 * A batch fetch that has settled, either way. See {@link Scanner.fetchBatch}.
 */
type Fetched =
  | { readonly ok: true; readonly batch: number; readonly transactions: readonly RpcTransaction[] }
  | { readonly ok: false; readonly batch: number; readonly error: unknown }

export interface ScannerOptions {
  rpc: ScanRpc
  logger: Logger
  networkId: number
  launchHeight: number
  pollIntervalMs: number
  onCandidate?: (candidate: NnsCandidate) => void | Promise<void>
  /**
   * Called once per batch, after its candidates are in canonical order and
   * **before the cursor advances** — so a throw here leaves the batch
   * unconsumed and the next tick retries it. That is what lets persistence
   * commit state and cursor together.
   */
  onBatchComplete?: (batch: CompletedBatch) => void | Promise<void>
  /**
   * How many batch fetches may be in flight at once. `1` is the serial loop.
   *
   * The scan's cost is round trips, not reduction: 502 batches/min serial over
   * the tunnel against 7,878 at a window of 16 (`docs/rpc-reference.md` §3),
   * and almost every batch of it is empty. The fetch order is free —
   * the node answers a batch the same whatever else is in flight — but the
   * **apply** order is not, and this window changes only the first. Batches are
   * consumed strictly in ascending order, one commit each, exactly as they were
   * when each fetch immediately preceded its own apply.
   */
  prefetch?: number
  /** Resume point, from a stored cursor. Overrides the `LAUNCH_HEIGHT` start. */
  startBatch?: number
  /**
   * Last batch to scan. {@link Scanner.run} returns once the cursor passes it
   * instead of idling for the next finalised batch.
   *
   * For `hybrid`'s background re-derivation (`shadow.ts`), which re-scans a
   * bounded range that the chain has long since finalised and must then stop —
   * a second scanner tailing the head forever would double every RPC call the
   * indexer makes, permanently, to verify nothing new.
   */
  stopAfterBatch?: number
  /** Injectable for tests. Must resolve early when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export class Scanner {
  private readonly rpc: ScanRpc
  private readonly logger: Logger
  private readonly networkId: number
  private readonly launchHeight: number
  private readonly pollIntervalMs: number
  private readonly onCandidate: ((candidate: NnsCandidate) => void | Promise<void>) | undefined
  private readonly onBatchComplete: ((batch: CompletedBatch) => void | Promise<void>) | undefined
  private readonly prefetch: number
  private readonly startBatchOverride: number | undefined
  private readonly stopAfterBatch: number | undefined
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>

  /**
   * Genesis anchor, measured from the node on the first tick. Undefined until
   * then: batch numbering starts at the PoS genesis, so this cannot be
   * computed, only measured.
   */
  private geometry: ChainGeometry | undefined

  /**
   * Next batch to scan. In-memory only — no checkpoints in this half.
   * Undefined until calibration, since `LAUNCH_HEIGHT` is a height and
   * turning it into a batch needs the anchor.
   */
  private cursor: number | undefined

  /**
   * Last finalised batch, as of the current tick. Undefined until the first
   * one. Reported, never acted on — the scan loop uses its own local `target`.
   */
  private target: number | undefined

  constructor(options: ScannerOptions) {
    this.rpc = options.rpc
    this.logger = options.logger
    this.networkId = options.networkId
    this.launchHeight = options.launchHeight
    this.pollIntervalMs = options.pollIntervalMs
    this.onCandidate = options.onCandidate
    this.onBatchComplete = options.onBatchComplete
    // Clamped rather than validated: `env.ts` refuses a window below 1 with a
    // message that names the variable, and a Scanner built in code with a
    // nonsense window should behave like the serial loop, not throw from a
    // constructor.
    this.prefetch = Math.max(1, Math.trunc(options.prefetch ?? 1))
    this.startBatchOverride = options.startBatch
    this.stopAfterBatch = options.stopAfterBatch
    this.sleep = options.sleep ?? delay
  }

  /** Undefined until the first tick has calibrated against the node. */
  get nextBatch(): number | undefined {
    return this.cursor
  }

  /**
   * The last finalised batch seen from the node, for progress reporting.
   * Undefined until the first tick.
   */
  get finalisedBatch(): number | undefined {
    return this.target
  }

  /** One pass: scan every batch that is finalised and not yet seen. */
  async tick(signal?: AbortSignal): Promise<number> {
    if (!(await this.rpc.isConsensusEstablished())) {
      this.logger.warn('scan.waiting', { reason: 'consensus not established' })
      return 0
    }

    const geometry = await this.calibrated()

    // The current batch comes from the node. It is never derived from a
    // height: batch numbers are relative to the PoS genesis, so `head / 60`
    // is wrong by tens of thousands of batches and wrong silently.
    const currentBatch = await this.rpc.getBatchNumber()
    const finalised = lastFinalisedBatch(currentBatch)
    // A bounded scan still never reads past finality: the ceiling is the lower
    // of the two, so `stopAfterBatch` can only shorten the range.
    const target = this.stopAfterBatch === undefined ? finalised : Math.min(finalised, this.stopAfterBatch)
    this.target = target

    let cursor = this.cursor ?? (await this.startBatch(geometry))
    this.cursor = cursor

    if (cursor > target) {
      this.logger.debug('scan.caught-up', { currentBatch, finalisedBatch: target, nextBatch: cursor })
      return 0
    }

    this.logger.info('scan.range', {
      currentBatch,
      finalisedBatch: target,
      fromBatch: cursor,
      toBatch: target,
      batches: target - cursor + 1,
    })

    // The prefetch window. Fetches run ahead; applies do not — `consumeBatch`
    // is called for `cursor`, then `cursor + 1`, one commit each, and the
    // cursor only ever advances past a batch whose `onBatchComplete` returned.
    const window: Promise<Fetched>[] = []
    let requested = cursor
    const fill = (): void => {
      while (window.length < this.prefetch && requested <= target) {
        window.push(this.fetchBatch(requested))
        requested += 1
      }
    }
    fill()

    let scanned = 0
    while (cursor <= target) {
      if (signal?.aborted === true) break
      // `shift` is undefined only for a window of zero, which the constructor
      // clamps away; the fallback keeps that impossible case serial rather
      // than silent.
      const fetched = await (window.shift() ?? this.fetchBatch(cursor))
      // Held as a value and thrown here rather than propagating from the fetch
      // itself: the window may hold several failures at once, and the one that
      // matters is the one at the cursor. The rest are dropped with the window
      // when this tick unwinds, and the next tick re-requests them. A fetch
      // whose batch is never reached is wasted, never lost.
      if (!fetched.ok) throw fetched.error
      // The window is in lockstep with the cursor by construction; this says
      // so out loud, because a concurrency bug that reordered applies would
      // otherwise surface as a wrong root a long way from here.
      if (fetched.batch !== cursor) {
        throw new ScanError(
          `the prefetch window handed batch ${fetched.batch} to the apply at batch ${cursor}`,
        )
      }
      await this.consumeBatch(cursor, fetched.transactions)
      cursor += 1
      this.cursor = cursor
      scanned += 1
      fill()
    }
    return scanned
  }

  private async calibrated(): Promise<ChainGeometry> {
    this.geometry ??= await calibrate(this.rpc, this.logger)
    return this.geometry
  }

  /**
   * The batch to start from, given `LAUNCH_HEIGHT`, once the node has been
   * shown to still hold it.
   *
   * `LAUNCH_HEIGHT` can sit mid-batch; the batch containing it is scanned
   * whole and the per-transaction height filter drops what precedes launch.
   * So the height the node must still hold is not the batch's first block but
   * the first block whose transactions can survive that filter — anything
   * below `LAUNCH_HEIGHT` is dropped whether the node has it or not.
   *
   * On a resume that height is the stored batch's first block: every block of
   * it counts, and a node resynced under a running indexer is the same
   * silent-empty failure as a fresh start below the horizon.
   */
  private async startBatch(geometry: ChainGeometry): Promise<number> {
    const fromLaunch = Math.max(1, geometry.batchAt(this.launchHeight))
    // A stored cursor wins: it is where the last committed transaction left
    // off, and rescanning from LAUNCH_HEIGHT would replay applied messages.
    const resumed = this.startBatchOverride !== undefined
    const batch = this.startBatchOverride ?? fromLaunch
    const firstBlock = geometry.firstBlockOf(batch)
    await assertHistoryHorizon({
      rpc: this.rpc,
      startHeight: Math.max(firstBlock, this.launchHeight),
      origin: resumed ? `the stored cursor's batch ${batch}, first block` : 'LAUNCH_HEIGHT',
      logger: this.logger,
    })
    this.logger.info('scan.start', {
      launchHeight: this.launchHeight,
      startBatch: batch,
      resumed,
      firstBlock,
    })
    return batch
  }

  /**
   * True once a bounded scan has passed its last batch. Always false for the
   * ordinary tail, which has no last batch.
   */
  private get finished(): boolean {
    return this.stopAfterBatch !== undefined && this.cursor !== undefined && this.cursor > this.stopAfterBatch
  }

  /** Run until the signal aborts, or until `stopAfterBatch` is passed. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const scanned = await this.tick(signal)
        if (signal.aborted) break
        if (this.finished) break
        // Only idle when there was nothing to do. A non-empty pass may have
        // been cut short by a newly finalised batch.
        if (scanned === 0) await this.sleep(this.pollIntervalMs, signal)
      } catch (error) {
        if (signal.aborted) break
        // Only the RPC layer's own failures are transient — the node
        // restarting, the network blinking — and the client already wraps
        // every one of those in its two classes (minus what it marks
        // `retryable: false` itself: bad credentials, a broken envelope).
        // Everything else is a rule or state problem (a checkpoint
        // divergence, a failed commit, a horizon refusal, a node answering
        // outside the batch), and retrying it is worse than dying twice over:
        // an indexer retrying forever at `error` level looks the same as an
        // indexer that is merely behind, and `CheckpointBuilder` has already
        // advanced the in-memory log hash past the failed commit, so a
        // replayed batch appends the same rows again (checkpoint.ts, "A
        // failed commit is fatal"). It leaves here, the process exits
        // non-zero, and a restart reseeds the fold from the log table.
        const transient =
          error instanceof RpcError || (error instanceof RpcTransportError && error.retryable)
        if (!transient) throw error
        this.logger.error('scan.error', { nextBatch: this.cursor, error })
        await this.sleep(this.pollIntervalMs, signal)
      }
    }
    this.logger.info('scan.stopped', { nextBatch: this.cursor })
  }

  /** Fetch one batch, rank per §5.2, apply §7.5's discovery filters, emit. */
  async scanBatch(batch: number): Promise<readonly NnsCandidate[]> {
    // Calibrated first, as it was when this method held the fetch inline: a
    // caller outside `tick` — a test, mostly — should see the same call order.
    await this.calibrated()
    return await this.consumeBatch(batch, await this.rpc.getTransactionsByBatchNumber(batch))
  }

  /**
   * One batch's fetch, settled rather than rejected.
   *
   * A window holds promises for batches the loop has not reached yet, and a
   * rejection sitting in one of those is an unhandled rejection the moment the
   * tick unwinds for another reason. So the failure is carried as a value and
   * raised by {@link tick} when the cursor arrives at it — which is also the
   * only point at which it means anything.
   */
  private fetchBatch(batch: number): Promise<Fetched> {
    return this.rpc.getTransactionsByBatchNumber(batch).then(
      (transactions): Fetched => ({ ok: true, batch, transactions }),
      (error: unknown): Fetched => ({ ok: false, batch, error }),
    )
  }

  /** Everything after the fetch: rank per §5.2, filter per §7.5, emit. */
  private async consumeBatch(
    batch: number,
    returned: readonly RpcTransaction[],
  ): Promise<readonly NnsCandidate[]> {
    const geometry = await this.calibrated()

    for (const tx of returned) {
      // If the method took a block number rather than a batch number we would
      // be scanning a different 60 blocks and never know. Assert instead.
      if (!geometry.heightInBatch(tx.blockNumber, batch)) {
        throw new ScanError(
          `getTransactionsByBatchNumber(${batch}) returned a transaction at height ${tx.blockNumber}, ` +
            `outside [${geometry.firstBlockOf(batch)}, ${geometry.macroBlockOf(batch)}] ` +
            `(PoS genesis ${geometry.genesisBlock})`,
        )
      }
    }

    // §5.2 (r27): core ranks the batch response directly — the universe is
    // every `NNS1`-prefixed transaction, before any §7.5 discard, so a
    // discarded message still occupies its rank. Rewards and inherents carry
    // no NNS1 payload and fall out of the universe with everything else
    // unprefixed; no body fetch, no reward heuristic.
    const ranked = rankMessages(returned)
    const droppedNotNns1 = returned.length - ranked.length

    // §7.5, in order — discovery filters over the ranked universe. The ranks
    // are already final: a discard here removes the message, never renumbers.
    let droppedFailedExecution = 0
    let droppedWrongNetwork = 0
    let droppedBeforeLaunch = 0
    const candidates: NnsCandidate[] = []
    for (const { tx, txIndex } of ranked) {
      if (tx.executionResult === false) {
        droppedFailedExecution += 1
        continue
      }
      if (tx.networkId !== this.networkId) {
        droppedWrongNetwork += 1
        continue
      }
      if (tx.blockNumber < this.launchHeight) {
        droppedBeforeLaunch += 1
        continue
      }
      candidates.push(toCandidate(tx, txIndex))
    }

    const summary: BatchSummary = {
      batch,
      firstBlock: geometry.firstBlockOf(batch),
      macroBlock: geometry.macroBlockOf(batch),
      returned: returned.length,
      candidates: candidates.length,
      droppedFailedExecution,
      droppedWrongNetwork,
      droppedBeforeLaunch,
      droppedNotNns1,
    }

    // A batch with nothing in it is the overwhelmingly common case; logging
    // every one of the 720 per day at info level would bury the hits.
    if (candidates.length > 0 || droppedWrongNetwork > 0 || droppedFailedExecution > 0) {
      this.logger.info('scan.batch', summary)
    } else {
      this.logger.debug('scan.batch', summary)
    }

    for (const candidate of candidates) {
      this.logger.info('nns.candidate', {
        batch,
        blockNumber: candidate.blockNumber,
        txIndex: candidate.txIndex,
        hash: candidate.hash,
        sender: candidate.sender,
        recipient: candidate.recipient,
        value: candidate.value,
        recipientData: candidate.recipientData,
        dataBytes: candidate.recipientData.length / 2,
      })
      await this.onCandidate?.(candidate)
    }
    await this.onBatchComplete?.({
      batch,
      firstBlock: summary.firstBlock,
      macroBlock: summary.macroBlock,
      candidates,
      summary,
    })

    return candidates
  }
}

function toCandidate(tx: RpcTransaction, txIndex: number): NnsCandidate {
  return {
    blockNumber: tx.blockNumber,
    txIndex,
    hash: tx.hash,
    sender: tx.from,
    recipient: tx.to,
    // Amounts are integer luna and bigint everywhere. The RPC hands them over
    // as JSON numbers; they are well inside 2^53, so this conversion is exact.
    value: BigInt(tx.value),
    fee: BigInt(tx.fee),
    recipientData: (tx.recipientData ?? '').toLowerCase(),
    networkId: tx.networkId,
    executionResult: tx.executionResult,
    timestamp: tx.timestamp,
    ...(tx.fromType !== undefined ? { senderType: tx.fromType } : {}),
    ...(tx.proof !== undefined ? { proof: tx.proof } : {}),
  }
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}
