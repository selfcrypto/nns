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

import { batchAt, heightInBatch, lastFinalisedBatch, lastFinalisedHeight } from './chain.js'
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

export interface ScannerOptions {
  rpc: ScanRpc
  logger: Logger
  networkId: number
  launchHeight: number
  pollIntervalMs: number
  onCandidate?: (candidate: NnsCandidate) => void | Promise<void>
  onBatch?: (summary: BatchSummary) => void | Promise<void>
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
  private readonly onBatch: ((summary: BatchSummary) => void | Promise<void>) | undefined
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private geometryChecked = false

  /** Next batch to scan. In-memory only — no checkpoints in this half. */
  private cursor: number

  constructor(options: ScannerOptions) {
    this.rpc = options.rpc
    this.logger = options.logger
    this.networkId = options.networkId
    this.launchHeight = options.launchHeight
    this.pollIntervalMs = options.pollIntervalMs
    this.onCandidate = options.onCandidate
    this.onBatch = options.onBatch
    this.sleep = options.sleep ?? delay
    // LAUNCH_HEIGHT can sit mid-batch; start at the batch containing it and
    // let the per-transaction height filter drop what precedes it.
    this.cursor = Math.max(1, batchAt(options.launchHeight))
  }

  get nextBatch(): number {
    return this.cursor
  }

  /** One pass: scan every batch that is finalised and not yet seen. */
  async tick(signal?: AbortSignal): Promise<number> {
    if (!(await this.rpc.isConsensusEstablished())) {
      this.logger.warn('scan.waiting', { reason: 'consensus not established' })
      return 0
    }

    const head = await this.rpc.getBlockNumber()
    if (!this.geometryChecked) await this.checkGeometry(head)

    const target = lastFinalisedBatch(head)
    if (this.cursor > target) {
      this.logger.debug('scan.caught-up', {
        head,
        finalisedHeight: lastFinalisedHeight(head),
        nextBatch: this.cursor,
      })
      return 0
    }

    this.logger.info('scan.range', {
      head,
      finalisedHeight: lastFinalisedHeight(head),
      fromBatch: this.cursor,
      toBatch: target,
      batches: target - this.cursor + 1,
    })

    let scanned = 0
    while (this.cursor <= target) {
      if (signal?.aborted === true) break
      await this.scanBatch(this.cursor)
      this.cursor += 1
      scanned += 1
    }
    return scanned
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

  /**
   * `docs/rpc-reference.md` §6 open item 1: the docs describe
   * `getTransactionsByBatchNumber`'s parameter as a *block* number while
   * naming it a batch method. If our 60-blocks-per-batch geometry were wrong,
   * every subsequent range assertion would fire — this just names the cause
   * once, at startup, instead of leaving it to be inferred.
   */
  private async checkGeometry(head: number): Promise<void> {
    this.geometryChecked = true
    const nodeBatch = await this.rpc.getBatchNumber()
    const derived = batchAt(head)
    // head and the batch number are read a moment apart, so ±1 across a
    // boundary is expected.
    if (Math.abs(nodeBatch - derived) > 1) {
      this.logger.warn('scan.geometry-mismatch', {
        head,
        nodeBatch,
        derivedBatch: derived,
        blocksPerBatch: 60,
        note: 'batch geometry assumption may be wrong — batch ranges below will not line up',
      })
    } else {
      this.logger.info('scan.geometry', { head, nodeBatch, derivedBatch: derived })
    }
  }

  /** Fetch one batch, apply §7.5's discovery filters, order, emit. */
  async scanBatch(batch: number): Promise<readonly NnsCandidate[]> {
    const returned = await this.rpc.getTransactionsByBatchNumber(batch)

    let droppedFailedExecution = 0
    let droppedWrongNetwork = 0
    let droppedBeforeLaunch = 0
    let droppedNotNns1 = 0
    const survivors: RpcTransaction[] = []

    for (const tx of returned) {
      // If the method took a block number rather than a batch number we would
      // be scanning a different 60 blocks and never know. Assert instead.
      if (!heightInBatch(tx.blockNumber, batch)) {
        throw new ScanError(
          `getTransactionsByBatchNumber(${batch}) returned a transaction at height ${tx.blockNumber}, ` +
            `outside that batch — confirm the parameter is a batch number, not a block number ` +
            `(docs/rpc-reference.md §6)`,
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
      firstBlock: (batch - 1) * 60 + 1,
      macroBlock: batch * 60,
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
    await this.onBatch?.(summary)

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
