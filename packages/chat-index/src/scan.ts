/**
 * The scan: batches in, chat rows out.
 *
 * Discovery is one prefix test on data the batch response already carries, so
 * the cost of a batch is one node call whether or not it holds any chat. No
 * block bodies are fetched: canonical order is a protocol concern (§5.2) and
 * chat has none — messages are ordered by the millisecond timestamp the node
 * already reports.
 *
 * The filters below are not validity rules. They drop transactions that are
 * not NC messages at all, and `@nns/chat`'s parser — the same one the app
 * runs — decides the rest.
 */

import { CHAT_PREFIX, attributedFrom, parseChatPayload } from '@nns/chat'

import type { Logger } from './logger.js'
import type { RpcClient, RpcTransaction } from './rpc.js'
import type { ChatRow } from './store.js'

/** `NC1` as lowercase hex: `recipientData` arrives hex-encoded. */
export const CHAT_PREFIX_HEX = Buffer.from(CHAT_PREFIX, 'ascii').toString('hex')

export function hasChatPrefix(recipientData: string | undefined): boolean {
  return recipientData !== undefined && recipientData.toLowerCase().startsWith(CHAT_PREFIX_HEX)
}

export interface BatchScan {
  readonly batch: number
  readonly returned: number
  readonly rows: readonly ChatRow[]
}

export function rowsFromBatch(
  batch: number,
  transactions: readonly RpcTransaction[],
  networkId: number,
  startHeight: number,
): BatchScan {
  const rows: ChatRow[] = []
  for (const tx of transactions) {
    // Failed transactions are still in blocks; a dropped message is not a
    // message. Reward transactions carry no payload and the prefix takes them.
    if (tx.executionResult === false) continue
    if (tx.networkId !== networkId) continue
    if (tx.blockNumber < startHeight) continue
    if (!hasChatPrefix(tx.recipientData)) continue
    const data = (tx.recipientData ?? '').toLowerCase()
    const payload = parseChatPayload(data)
    // A malformed NC1 payload is not a message: there is nothing to show a
    // reader, so it is dropped rather than stored.
    if (payload === null) continue
    rows.push({
      txHash: tx.hash,
      blockNumber: tx.blockNumber,
      timestamp: tx.timestamp,
      // Attributed at scan time, mirroring §8.2's log: the stored sender is
      // the effective sender, so querying a Nimiq Pay user's durable address
      // finds their messages even after the signing HTLC is pruned. Served
      // rows carry no proof — this is where attribution happens or nowhere.
      sender: attributedFrom(tx),
      recipient: tx.to,
      message: payload.message,
      recipientData: data,
    })
  }
  return { batch, returned: transactions.length, rows }
}

export interface ScannerOptions {
  readonly rpc: RpcClient
  readonly logger: Logger
  readonly networkId: number
  readonly startHeight: number
  readonly onBatch: (scan: BatchScan, nextBatch: number) => Promise<void>
  readonly startBatch?: number | undefined
}

/** The start height is above the head: not an error, a wait. `main` sleeps and retries. */
export class StartAheadOfHead extends Error {
  override readonly name = 'StartAheadOfHead'
  readonly startHeight: number
  readonly head: number
  constructor(startHeight: number, head: number) {
    super(`start height ${startHeight} is ${startHeight - head} blocks above the head ${head}`)
    this.startHeight = startHeight
    this.head = head
  }
}

export class Scanner {
  private cursor: number | undefined
  private readonly options: ScannerOptions

  constructor(options: ScannerOptions) {
    this.options = options
    this.cursor = options.startBatch
  }

  get nextBatch(): number | undefined {
    return this.cursor
  }

  /**
   * Where to begin, asked of the node rather than computed.
   *
   * `floor(height / 60)` is wrong by tens of thousands of batches, because
   * batch numbers count from the PoS genesis — and wrong silently, since a
   * nonexistent batch answers `[]`. The block's own `batch` field is exact.
   * The same call is the horizon probe: a start height the node no longer
   * holds throws here, which is the only way to tell an empty range from a
   * pruned one.
   */
  private async resolveStart(): Promise<number> {
    if (this.cursor !== undefined) return this.cursor
    // A start height the chain has not reached yet answers the same "not
    // found" as a pruned one. Asking the head first tells them apart: below
    // it is the horizon refusal; above it is a launch in the future, and the
    // scan waits for the block rather than exiting.
    const head = await this.options.rpc.getBlockNumber()
    if (head < this.options.startHeight) {
      throw new StartAheadOfHead(this.options.startHeight, head)
    }
    const batch = await this.options.rpc.batchOfBlock(this.options.startHeight)
    this.options.logger.info('chat.start', { startHeight: this.options.startHeight, startBatch: batch })
    this.cursor = batch
    return batch
  }

  /** One pass: every finalised batch not yet scanned. Returns how many. */
  async tick(signal?: AbortSignal): Promise<number> {
    if (!(await this.options.rpc.isConsensusEstablished())) {
      this.options.logger.warn('chat.waiting', { reason: 'consensus not established' })
      return 0
    }
    // One batch behind the head: a micro block can still be reverted, and a
    // reverted chat message that stayed in the index would be a message the
    // chain does not have.
    const target = Math.max(0, (await this.options.rpc.getBatchNumber()) - 1)
    let cursor = await this.resolveStart()
    let scanned = 0
    while (cursor <= target) {
      if (signal?.aborted === true) break
      const transactions = await this.options.rpc.getTransactionsByBatchNumber(cursor)
      const scan = rowsFromBatch(cursor, transactions, this.options.networkId, this.options.startHeight)
      cursor += 1
      await this.options.onBatch(scan, cursor)
      this.cursor = cursor
      scanned += 1
      if (scan.rows.length > 0) {
        this.options.logger.info('chat.batch', { batch: scan.batch, returned: scan.returned, rows: scan.rows.length })
      } else {
        this.options.logger.debug('chat.batch', { batch: scan.batch, returned: scan.returned, rows: 0 })
      }
    }
    return scanned
  }
}
