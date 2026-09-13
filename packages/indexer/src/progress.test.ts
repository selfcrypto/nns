import { defineConfig, initialState, type Checkpoint, type NnsState } from '@nimiqnames/core'
import { describe, expect, it } from 'vitest'

import { Progress } from './progress.js'
import type { BatchResult, VerdictCounts } from './pipeline.js'
import type { LogRow } from './rows.js'
import { collectingLogger } from './test-fixtures.js'

const A = 'NQ28 TKBF VF67 HP8R Y812 5FNM NNDN TS7Q F5G3' // CONSTANTS.TREASURY_ADDRESS, spaced as the RPC prints it
const B = 'NQ38 NKD4 7ALG YRDQ DXL8 PARE 7JRS JGJD MAU8' // CONSTANTS.PROTOCOL_ADDRESS
const C = 'NQ80 6XNV JDFY YEKF HMM3 UCYK VBLP 7H6Y FNXS' // CONSTANTS.ADMIN_ADDRESS
const D = 'NQ71 TPMV QN9D MV6A 1HX1 NL2Q 4CJG 5J8M QPTB' // CONSTANTS.MARKETPLACE_ADDRESS

const CONFIG = defineConfig({ networkId: 24 })

const STATE: NnsState = initialState()

function logRow(blockHeight: number): LogRow {
  return {
    block_height: blockHeight,
    tx_index: 0,
    tx_hash: 'ab'.repeat(32),
    sender: A.replace(/ /g, ''),
    recipient: B.replace(/ /g, ''),
    value: '1',
    data: '-',
    verdict: 'OK',
  }
}

function result(overrides: Omit<Partial<BatchResult>, 'counts'> & { counts?: Partial<VerdictCounts> } = {}): BatchResult {
  const { counts, ...rest } = overrides
  return {
    state: STATE,
    logRows: [],
    boundariesCrossed: [],
    ...rest,
    counts: { ok: 0, forfeit: 0, refund: 0, ignored: 0, ...counts },
  }
}

function checkpoint(height: number, byte: number): Checkpoint {
  const bytes = (fill: number) => new Uint8Array(32).fill(fill)
  return {
    height,
    nameRoot: bytes(byte),
    pricesRoot: bytes(byte),
    pendingRoot: bytes(byte),
    unreservedRoot: bytes(byte),
    logHash: bytes(byte),
    commitment: bytes(byte),
  }
}

/** A clock the test advances by hand, so cadence is tested rather than timed. */
function clock(start = 1_000_000) {
  let time = start
  return { now: () => time, advance: (ms: number) => (time += ms) }
}

function setup(
  options: {
    intervalMs?: number
    everyBatches?: number
    target?: () => number | undefined
    startHeight?: number
  } = {},
) {
  const { logger, lines } = collectingLogger()
  const time = clock()
  const progress = new Progress({ logger, now: time.now, ...options })
  const progressLines = () => lines.filter((line) => line['msg'] === 'indexer.progress')
  return { progress, lines, progressLines, advance: time.advance }
}

describe('Progress', () => {
  it('logs every batch, at info only when something happened in it', () => {
    const { progress, lines } = setup()
    progress.batchCommitted(1, 60, result(), [])
    progress.batchCommitted(2, 120, result({ logRows: [logRow(100)], counts: { ok: 1 } }), [])

    const batchLines = lines.filter((line) => line['msg'] === 'reduce.batch')
    expect(batchLines.map((line) => line['level'])).toEqual(['debug', 'info'])
    expect(batchLines[1]).toMatchObject({ batch: 2, height: 120, logged: 1, ok: 1 })
  })

  it('stays quiet until the interval has passed', () => {
    const { progress, progressLines, advance } = setup({ intervalMs: 60_000 })
    progress.batchCommitted(1, 60, result(), [])
    advance(59_000)
    progress.batchCommitted(2, 120, result(), [])
    expect(progressLines()).toHaveLength(0)

    advance(2_000)
    progress.batchCommitted(3, 180, result(), [])
    expect(progressLines()).toHaveLength(1)
  })

  it('also fires on batch count, so a fast backfill is not silent between ticks', () => {
    const { progress, progressLines } = setup({ intervalMs: 60_000, everyBatches: 3 })
    // The clock never moves: only the stride can trigger these.
    for (let batch = 1; batch <= 7; batch += 1) progress.batchCommitted(batch, batch * 60, result(), [])
    expect(progressLines()).toHaveLength(2)
    expect(progressLines()[0]).toMatchObject({ batch: 3, batches: 3 })
    expect(progressLines()[1]).toMatchObject({ batch: 6, batches: 6 })
  })

  it('accumulates verdict counts over the run', () => {
    const { progress, progressLines } = setup({ everyBatches: 2 })
    progress.batchCommitted(1, 60, result({ logRows: [logRow(30)], counts: { ok: 1, ignored: 2 } }), [])
    progress.batchCommitted(2, 120, result({ logRows: [logRow(90)], counts: { forfeit: 1, refund: 3, ignored: 1 } }), [])

    expect(progressLines()[0]).toMatchObject({
      ok: 1,
      forfeit: 1,
      refund: 3,
      ignored: 3,
      logged: 2,
      batches: 2,
      height: 120,
    })
  })

  it('carries the latest checkpoint root, and counts every one built', () => {
    const { progress, progressLines } = setup({ everyBatches: 2 })
    progress.batchCommitted(1, 720, result(), [checkpoint(720, 0xaa)])
    progress.batchCommitted(2, 1_440, result(), [checkpoint(1_440, 0xbb), checkpoint(2_160, 0xcc)])

    // The root is hex, because the logger encodes a Uint8Array that way — the
    // same encoding `checkpoint.built` reports, so the two lines can be joined.
    expect(progressLines()[0]).toMatchObject({
      checkpoints: 3,
      checkpointHeight: 2_160,
      commitment: 'cc'.repeat(32),
    })
  })

  it('reports how far behind the chain it is, and an ETA from the current rate', () => {
    const { progress, progressLines, advance } = setup({
      intervalMs: 10_000,
      target: () => 1_000,
    })
    for (let batch = 1; batch <= 20; batch += 1) {
      advance(500) // 2 batches per second
      progress.batchCommitted(batch, batch * 60, result(), [])
    }
    const last = progressLines().at(-1)
    expect(last).toMatchObject({ batchesPerSecond: 2, behindBatches: 980, etaSeconds: 490 })
  })

  it('omits the chain-relative fields when the node has not been reached yet', () => {
    const { progress, progressLines } = setup({ everyBatches: 1, target: () => undefined })
    progress.batchCommitted(1, 60, result(), [])
    const line = progressLines()[0] ?? {}
    expect(line).not.toHaveProperty('behindBatches')
    expect(line).not.toHaveProperty('etaSeconds')
    expect(line).not.toHaveProperty('commitment')
  })

  it('flushes the run totals on demand, whatever the cadence had reached', () => {
    const { progress, progressLines } = setup({ intervalMs: 3_600_000 })
    progress.batchCommitted(1, 60, result({ counts: { ok: 2 } }), [])
    expect(progressLines()).toHaveLength(0)

    progress.flush('stop')
    expect(progressLines()[0]).toMatchObject({ reason: 'stop', ok: 2, batches: 1, batch: 1, height: 60 })
  })

  it('reports the resume height before any batch has been committed', () => {
    // The stalled-run case: a heartbeat with nothing in it but the height it
    // is stuck at is the one that distinguishes a long backfill from a wedge.
    const { progress, progressLines } = setup({ startHeight: 58_177_440 })
    progress.flush('stop')
    const line = progressLines()[0] ?? {}
    expect(line).toMatchObject({ height: 58_177_440, batches: 0 })
    expect(line).not.toHaveProperty('batch')
  })

  it('measures the rate over the window, not over the run', () => {
    const { progress, progressLines, advance } = setup({ intervalMs: 1_000 })
    // A fast backfill…
    for (let batch = 1; batch <= 100; batch += 1) {
      advance(10)
      progress.batchCommitted(batch, batch * 60, result(), [])
    }
    // …then the tail: one batch a minute.
    advance(60_000)
    progress.batchCommitted(101, 6_060, result(), [])

    expect(progressLines().at(-1)).toMatchObject({ batchesPerSecond: 0.02 })
  })
})
