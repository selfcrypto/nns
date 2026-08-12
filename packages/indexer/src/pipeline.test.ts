import { CONSTANTS, defineConfig, initialState } from '@nns/core'
import { describe, expect, it } from 'vitest'

import { Pipeline, advanceThroughBoundaries, nextBoundaryAbove, toChainTransaction } from './pipeline.js'
import type { NnsCandidate } from './scan.js'
import { collectingLogger, payload } from './test-fixtures.js'

// Valid addresses: the checksum is part of the format, so a made-up NQ11…
// string is rejected by `parseAddress`.
const A = 'NQ34 248H 248H 248H 248H 248H 248H 248H 248H'
const B = 'NQ93 48H2 48H2 48H2 48H2 48H2 48H2 48H2 48H2'
const C = 'NQ60 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK'
const D = 'NQ14 8H24 8H24 8H24 8H24 8H24 8H24 8H24 8H24'

const LAUNCH = 58_176_000 // a multiple of CHECKPOINT_INTERVAL, so boundaries are easy to read

const CONFIG = defineConfig({
  networkId: 24,
  launchHeight: LAUNCH,
  treasury: A,
  protocol: B,
  admin: C,
  marketplace: D,
  listingFee: 100_000n,
})

function candidate(overrides: Partial<NnsCandidate> & { blockNumber: number }): NnsCandidate {
  return {
    txIndex: 0,
    hash: 'ab'.repeat(32),
    sender: 'NQ64 VFXQ TPAS 5Q7S ADEX 072S CR2M QCQ4 8P8M',
    recipient: B,
    value: 1n,
    fee: 0n,
    recipientData: payload('NNS1Gtestname'),
    networkId: 24,
    executionResult: true,
    timestamp: 1_700_000_000,
    ...overrides,
  }
}

function pipeline() {
  const { logger, lines } = collectingLogger()
  return { pipeline: new Pipeline(CONFIG, logger), lines }
}

describe('checkpoint boundaries', () => {
  it('steps by CHECKPOINT_INTERVAL from an absolute origin', () => {
    expect(CONSTANTS.CHECKPOINT_INTERVAL).toBe(720)
    expect(nextBoundaryAbove(0)).toBe(720)
    expect(nextBoundaryAbove(719)).toBe(720)
    // A height that IS a boundary has already had it applied.
    expect(nextBoundaryAbove(720)).toBe(1440)
    expect(nextBoundaryAbove(58_176_000)).toBe(58_176_720)
  })

  it('applies every boundary in the gap, in order', () => {
    const seen: number[] = []
    const state = advanceThroughBoundaries(initialState(CONFIG), LAUNCH + 1_500, (height) => seen.push(height))
    expect(seen).toEqual([LAUNCH + 720, LAUNCH + 1_440])
    // …and lands on the target itself, not on the last boundary.
    expect(state.height).toBe(LAUNCH + 1_500)
  })

  it('crosses no boundary inside one batch that spans none', () => {
    const seen: number[] = []
    advanceThroughBoundaries(initialState(CONFIG), LAUNCH + 60, (height) => seen.push(height))
    expect(seen).toEqual([])
  })

  it('never moves backwards', () => {
    const state = advanceThroughBoundaries(initialState(CONFIG), LAUNCH + 5_000)
    expect(advanceThroughBoundaries(state, LAUNCH + 100).height).toBe(LAUNCH + 5_000)
  })
})

describe('applyBatch', () => {
  it('advances to the macro block even with nothing in the batch', () => {
    // The MUST in §7.3. An implementation that advances only on messages
    // passes almost every test and then commits a stale root.
    const { pipeline: p } = pipeline()
    const macroBlock = LAUNCH + 1_440
    const result = p.applyBatch(initialState(CONFIG), [], macroBlock)
    expect(result.state.height).toBe(macroBlock)
    expect(result.boundariesCrossed.map((crossing) => crossing.height)).toEqual([LAUNCH + 720, LAUNCH + 1_440])
    // Each carries the state as of its own height — a checkpoint at LAUNCH+720
    // must not commit the state as of the macro block above it.
    expect(result.boundariesCrossed.map((crossing) => crossing.state.height)).toEqual([LAUNCH + 720, LAUNCH + 1_440])
    expect(result.logRows).toEqual([])
  })

  it('registers a name and writes exactly one log line', () => {
    const { pipeline: p } = pipeline()
    const result = p.applyBatch(
      initialState(CONFIG),
      [
        candidate({
          blockNumber: LAUNCH + 10,
          recipientData: payload('NNS1Gtestname'),
          value: CONSTANTS.FEE_STANDARD,
          recipient: A, // the treasury takes the fee
        }),
      ],
      LAUNCH + 60,
    )
    expect(result.counts.ok).toBe(1)
    expect(result.state.names.has('testname')).toBe(true)
    expect(result.logRows).toHaveLength(1)
    expect(result.logRows[0]).toMatchObject({
      block_height: LAUNCH + 10,
      tx_index: 0,
      verdict: 'OK',
      // §8.2: hex, lowercase, never raw text.
      data: payload('NNS1Gtestname'),
    })
  })

  it('logs a rejection with its verdict rather than dropping it', () => {
    // §7.6 and the indexer's own rule: an independent replay must be able to
    // confirm that a rejection was correct.
    const { pipeline: p } = pipeline()
    const result = p.applyBatch(
      initialState(CONFIG),
      [candidate({ blockNumber: LAUNCH + 10, recipientData: payload('NNS1Gab'), recipient: A })],
      LAUNCH + 60,
    )
    expect(result.counts.forfeit).toBe(1)
    expect(result.logRows).toHaveLength(1)
    expect(result.logRows[0]?.verdict).toBe('INVALID_NAME')
  })

  it('gives an IGNORED message no log line at all (§7.6)', () => {
    const { pipeline: p } = pipeline()
    const result = p.applyBatch(
      initialState(CONFIG),
      [candidate({ blockNumber: LAUNCH + 10, executionResult: false })],
      LAUNCH + 60,
    )
    expect(result.counts.ignored).toBe(1)
    expect(result.logRows).toEqual([])
  })

  it('rejects candidates that are not in canonical order', () => {
    const { pipeline: p } = pipeline()
    expect(() =>
      p.applyBatch(
        initialState(CONFIG),
        [candidate({ blockNumber: LAUNCH + 20 }), candidate({ blockNumber: LAUNCH + 10 })],
        LAUNCH + 60,
      ),
    ).toThrow(/canonical order/)
  })

  it('refuses to replay a height already passed', () => {
    // Replay is forward-only: `advanceTo` throws rather than reapplying
    // effects, which is what makes a resumed run identical to a fresh one.
    const { pipeline: p } = pipeline()
    const first = p.applyBatch(initialState(CONFIG), [], LAUNCH + 120)
    expect(() => p.applyBatch(first.state, [candidate({ blockNumber: LAUNCH + 60 })], LAUNCH + 180)).toThrow(
      /cannot advance/,
    )
  })

  it('rejects two candidates claiming one position', () => {
    const { pipeline: p } = pipeline()
    expect(() =>
      p.applyBatch(
        initialState(CONFIG),
        [candidate({ blockNumber: LAUNCH + 10, txIndex: 1 }), candidate({ blockNumber: LAUNCH + 10, txIndex: 1 })],
        LAUNCH + 60,
      ),
    ).toThrow(/canonical order/)
  })

  it('is deterministic: one batch of three equals three batches of one', () => {
    // The property the whole design rests on — a replay split differently
    // across batches must reach the same state.
    // One message per batch of 60, so the split is a real batch boundary.
    const messages = [
      candidate({ blockNumber: LAUNCH + 10, recipientData: payload('NNS1Gfirstname'), value: CONSTANTS.FEE_STANDARD, recipient: A }),
      candidate({ blockNumber: LAUNCH + 70, recipientData: payload('NNS1Gsecondname'), value: CONSTANTS.FEE_STANDARD, recipient: A }),
      candidate({ blockNumber: LAUNCH + 130, recipientData: payload('NNS1Gthirdname'), value: CONSTANTS.FEE_STANDARD, recipient: A }),
    ]
    const { pipeline: p } = pipeline()

    const together = p.applyBatch(initialState(CONFIG), messages, LAUNCH + 2_000)

    let state = initialState(CONFIG)
    const rows = []
    for (const [index, message] of messages.entries()) {
      const step = p.applyBatch(state, [message], LAUNCH + 60 * (index + 1))
      state = step.state
      rows.push(...step.logRows)
    }
    state = p.applyBatch(state, [], LAUNCH + 2_000).state

    expect(state.height).toBe(together.state.height)
    expect([...state.names.keys()].sort()).toEqual([...together.state.names.keys()].sort())
    expect(rows).toEqual(together.logRows)
  })
})

describe('toChainTransaction', () => {
  it('throws rather than guessing a verdict for an unparseable address', () => {
    expect(() => toChainTransaction(candidate({ blockNumber: LAUNCH + 1, sender: 'NQ00 nope' }))).toThrow(
      /unparseable address/,
    )
  })
})
