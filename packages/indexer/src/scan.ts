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
 */

import { CONSTANTS } from '@nns/core'

import { type ChainGeometry, calibrate, lastFinalisedBatch } from './chain.js'
import type { Logger } from './logger.js'
import { resolvePositions } from './ordering.js'
import type { RpcClient, RpcTransaction } from './rpc.js'

/** `NNS1` as lowercase hex — `recipientData` arrives hex-encoded (§5.1). */
export const PROTOCOL_PREFIX_HEX = Buffer.from(CONSTANTS.PROTOCOL_ID, 'ascii').toString('hex')

export class ScanError extends Error {
  override readonly name = 'ScanError'
}

/**
 * A transaction that carries the `NNS1` prefix and survived §7.5, stamped
 * with its canonical position.
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
  /** Resume point, from a stored cursor. Overrides the `LAUNCH_HEIGHT` start. */
  startBatch?: number
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
  private readonly startBatchOverride: number | undefined
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

  constructor(options: ScannerOptions) {
    this.rpc = options.rpc
    this.logger = options.logger
    this.networkId = options.networkId
    this.launchHeight = options.launchHeight
    this.pollIntervalMs = options.pollIntervalMs
    this.onCandidate = options.onCandidate
    this.onBatchComplete = options.onBatchComplete
    this.startBatchOverride = options.startBatch
    this.sleep = options.sleep ?? delay
  }

  /** Undefined until the first tick has calibrated against the node. */
  get nextBatch(): number | undefined {
    return this.cursor
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
    const target = lastFinalisedBatch(currentBatch)

    let cursor = this.cursor ?? this.startBatch(geometry)
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

    let scanned = 0
    while (cursor <= target) {
      if (signal?.aborted === true) break
      await this.scanBatch(cursor)
      cursor += 1
      this.cursor = cursor
      scanned += 1
    }
    return scanned
  }

  private async calibrated(): Promise<ChainGeometry> {
    this.geometry ??= await calibrate(this.rpc, this.logger)
    return this.geometry
  }

  /**
   * The batch to start from, given `LAUNCH_HEIGHT`.
   *
   * `LAUNCH_HEIGHT` can sit mid-batch; the batch containing it is scanned
   * whole and the per-transaction height filter drops what precedes launch.
   */
  private startBatch(geometry: ChainGeometry): number {
    const fromLaunch = Math.max(1, geometry.batchAt(this.launchHeight))
    // A stored cursor wins: it is where the last committed transaction left
    // off, and rescanning from LAUNCH_HEIGHT would replay applied messages.
    const batch = this.startBatchOverride ?? fromLaunch
    this.logger.info('scan.start', {
      launchHeight: this.launchHeight,
      startBatch: batch,
      resumed: this.startBatchOverride !== undefined,
      firstBlock: geometry.firstBlockOf(batch),
    })
    return batch
  }

  /** Run until the signal aborts. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const scanned = await this.tick(signal)
        if (signal.aborted) break
        // Only idle when there was nothing to do. A non-empty pass may have
        // been cut short by a newly finalised batch.
        if (scanned === 0) await this.sleep(this.pollIntervalMs, signal)
      } catch (error) {
        if (signal.aborted) break
        this.logger.error('scan.error', { nextBatch: this.cursor, error })
        await this.sleep(this.pollIntervalMs, signal)
      }
    }
    this.logger.info('scan.stopped', { nextBatch: this.cursor })
  }

  /** Fetch one batch, apply §7.5's discovery filters, order, emit. */
  async scanBatch(batch: number): Promise<readonly NnsCandidate[]> {
    const geometry = await this.calibrated()
    const returned = await this.rpc.getTransactionsByBatchNumber(batch)

    let droppedFailedExecution = 0
    let droppedWrongNetwork = 0
    let droppedBeforeLaunch = 0
    let droppedNotNns1 = 0
    const survivors: RpcTransaction[] = []

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
      // §7.5, in order. Reward transactions need no rule of their own: they
      // carry no NNS1 payload, so the prefix filter takes them.
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
      if (!hasProtocolPrefix(tx.recipientData)) {
        droppedNotNns1 += 1
        continue
      }
      survivors.push(tx)
    }

    const positioned = await resolvePositions(this.rpc, survivors)
    const candidates = positioned.map(({ tx, txIndex }) => toCandidate(tx, txIndex))

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
