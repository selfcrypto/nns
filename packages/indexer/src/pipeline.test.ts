import { CONSTANTS, defineConfig, initialState } from '@nns/core'
import { describe, expect, it } from 'vitest'

import {
  Pipeline,
  advanceThroughBoundaries,
  nextBoundaryAbove,
  toChainTransaction,
  type PipelineOptions,
} from './pipeline.js'
import type { NnsCandidate } from './scan.js'
import { collectingLogger, payload } from './test-fixtures.js'

// Valid addresses: the checksum is part of the format, so a made-up NQ11…
// string is rejected by `parseAddress`.
const A = 'NQ28 TKBF VF67 HP8R Y812 5FNM NNDN TS7Q F5G3' // CONSTANTS.TREASURY_ADDRESS, spaced as the RPC prints it
const B = 'NQ38 NKD4 7ALG YRDQ DXL8 PARE 7JRS JGJD MAU8' // CONSTANTS.PROTOCOL_ADDRESS
const C = 'NQ80 6XNV JDFY YEKF HMM3 UCYK VBLP 7H6Y FNXS' // CONSTANTS.ADMIN_ADDRESS
const D = 'NQ71 TPMV QN9D MV6A 1HX1 NL2Q 4CJG 5J8M QPTB' // CONSTANTS.MARKETPLACE_ADDRESS

const LAUNCH = CONSTANTS.LAUNCH_HEIGHT // a multiple of CHECKPOINT_INTERVAL, so boundaries read easily

const CONFIG = defineConfig({ networkId: 24 })

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

/**
 * @param options `lastCheckpointHeight` for a resumed run; omitted is a fresh
 *   one, which is the case that has `LAUNCH` itself as its first boundary.
 */
function pipeline(options: PipelineOptions = {}) {
  const { logger, lines } = collectingLogger()
  return { pipeline: new Pipeline(CONFIG, logger, options), lines }
}

describe('checkpoint boundaries', () => {
  it('steps by CHECKPOINT_INTERVAL from an absolute origin', () => {
    expect(CONSTANTS.CHECKPOINT_INTERVAL).toBe(720)
    const interval = CONSTANTS.CHECKPOINT_INTERVAL
    expect(nextBoundaryAbove(0, interval)).toBe(720)
    expect(nextBoundaryAbove(719, interval)).toBe(720)
    // A height that IS a boundary has already had it applied.
    expect(nextBoundaryAbove(720, interval)).toBe(1440)
    expect(nextBoundaryAbove(58_176_000, interval)).toBe(58_176_720)
  })

  it('applies every boundary in the gap, in order', () => {
    const seen: number[] = []
    const state = advanceThroughBoundaries(initialState(), LAUNCH + 1_500, (height) => seen.push(height))
    expect(seen).toEqual([LAUNCH + 720, LAUNCH + 1_440])
    // …and lands on the target itself, not on the last boundary.
    expect(state.height).toBe(LAUNCH + 1_500)
  })

  it('crosses no boundary inside one batch that spans none', () => {
    const seen: number[] = []
    advanceThroughBoundaries(initialState(), LAUNCH + 60, (height) => seen.push(height))
    expect(seen).toEqual([])
  })

  it('never moves backwards', () => {
    const state = advanceThroughBoundaries(initialState(), LAUNCH + 5_000)
    expect(advanceThroughBoundaries(state, LAUNCH + 100).height).toBe(LAUNCH + 5_000)
  })

  it('takes a boundary at the state’s own height when it has not been committed', () => {
    // The `after` argument, and the only case that uses it: a state sitting on
    // a boundary nobody has committed yet.
    const seen: number[] = []
    advanceThroughBoundaries(initialState(), LAUNCH + 60, (height) => seen.push(height), LAUNCH - 1)
    expect(seen).toEqual([LAUNCH])
  })

  it('does not reach back below the state for a stale `after`', () => {
    // `advanceTo` moves forward only, so a boundary below `state.height` is one
    // an earlier call already passed. Clamped rather than thrown at.
    const seen: number[] = []
    const state = advanceThroughBoundaries(initialState(), LAUNCH + 1_500)
    advanceThroughBoundaries(state, LAUNCH + 2_200, (height) => seen.push(height), LAUNCH - 1)
    expect(seen).toEqual([LAUNCH + 2_160])
  })
})

describe('applyBatch', () => {
  it('advances to the macro block even with nothing in the batch', () => {
    // The MUST in §7.3. An implementation that advances only on messages
    // passes almost every test and then commits a stale root.
    const { pipeline: p } = pipeline()
    const macroBlock = LAUNCH + 1_440
    const result = p.applyBatch(initialState(), [], macroBlock)
    expect(result.state.height).toBe(macroBlock)
    // LAUNCH leads, because it is itself a multiple of the interval.
    expect(result.boundariesCrossed.map((crossing) => crossing.height)).toEqual([LAUNCH, LAUNCH + 720, LAUNCH + 1_440])
    // Each carries the state as of its own height — a checkpoint at LAUNCH+720
    // must not commit the state as of the macro block above it.
    expect(result.boundariesCrossed.map((crossing) => crossing.state.height)).toEqual([
      LAUNCH,
      LAUNCH + 720,
      LAUNCH + 1_440,
    ])
    expect(result.logRows).toEqual([])
  })

  it('registers a name and writes exactly one log line', () => {
    const { pipeline: p } = pipeline()
    const result = p.applyBatch(
      initialState(),
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
      initialState(),
      [candidate({ blockNumber: LAUNCH + 10, recipientData: payload('NNS1Gab-'), recipient: A })],
      LAUNCH + 60,
    )
    expect(result.counts.forfeit).toBe(1)
    expect(result.logRows).toHaveLength(1)
    // `ab-` fails §4.1 rules 2–5; a well-formed `ab` would be RESERVED_NAME
    // since r18 — reserved by rule, not invalid.
    expect(result.logRows[0]?.verdict).toBe('INVALID_NAME')
  })

  it('gives an IGNORED message no log line at all (§7.6)', () => {
    const { pipeline: p } = pipeline()
    const result = p.applyBatch(
      initialState(),
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
        initialState(),
        [candidate({ blockNumber: LAUNCH + 20 }), candidate({ blockNumber: LAUNCH + 10 })],
        LAUNCH + 60,
      ),
    ).toThrow(/canonical order/)
  })

  it('refuses to replay a height already passed', () => {
    // Replay is forward-only: `advanceTo` throws rather than reapplying
    // effects, which is what makes a resumed run identical to a fresh one.
    const { pipeline: p } = pipeline()
    const first = p.applyBatch(initialState(), [], LAUNCH + 120)
    expect(() => p.applyBatch(first.state, [candidate({ blockNumber: LAUNCH + 60 })], LAUNCH + 180)).toThrow(
      /cannot advance/,
    )
  })

  it('rejects two candidates claiming one position', () => {
    const { pipeline: p } = pipeline()
    expect(() =>
      p.applyBatch(
        initialState(),
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
    // Two instances, because a `Pipeline` remembers the boundaries it has
    // emitted: replaying the same chain through one would be a second run, not
    // a second derivation of the first.
    const { pipeline: whole } = pipeline()
    const { pipeline: p } = pipeline()

    const together = whole.applyBatch(initialState(), messages, LAUNCH + 2_000)

    let state = initialState()
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

describe('LAUNCH_HEIGHT as a boundary (§8.1)', () => {
  // "Checkpoint heights are absolute multiples of CHECKPOINT_INTERVAL …
  // LAUNCH_HEIGHT itself never gets a checkpoint unless it happens to be such a
  // multiple." It does happen to be one here — and used to get no checkpoint
  // anyway, because the boundary walk was strictly above the current height and
  // the initial state starts *at* LAUNCH_HEIGHT.
  const OFF_BOUNDARY = LAUNCH + 1 // …the same launch, one block later

  it('is a multiple of CHECKPOINT_INTERVAL, which is what makes it one', () => {
    expect(LAUNCH % CONSTANTS.CHECKPOINT_INTERVAL).toBe(0)
  })

  it('checkpoints LAUNCH_HEIGHT itself, before anything in the launch block', () => {
    const { pipeline: p } = pipeline()
    const result = p.applyBatch(
      initialState(),
      [candidate({ blockNumber: LAUNCH, recipientData: payload('NNS1Gtestname'), value: CONSTANTS.FEE_STANDARD, recipient: A })],
      LAUNCH + 60,
    )
    expect(result.boundariesCrossed.map((crossing) => crossing.height)).toEqual([LAUNCH])
    // The launch registration is *not* under the launch checkpoint: a boundary
    // fires before the transactions at its own height (§7.3), so the state it
    // commits is the empty one and the log prefix it covers is empty.
    const [launchBoundary] = result.boundariesCrossed
    expect(launchBoundary?.state.names.size).toBe(0)
    expect(launchBoundary?.logRowsBefore).toBe(0)
    expect(result.logRows).toHaveLength(1)
  })

  it('emits it even when the launch block is itself the batch’s macro block', () => {
    // 720 is a multiple of 60, so a LAUNCH_HEIGHT on a boundary is always a
    // macro block too: the first batch can begin and end at it.
    const { pipeline: p } = pipeline()
    expect(p.applyBatch(initialState(), [], LAUNCH).boundariesCrossed.map((c) => c.height)).toEqual([LAUNCH])
  })

  it('emits it exactly once, however the batches fall', () => {
    const { pipeline: p } = pipeline()
    const first = p.applyBatch(initialState(), [], LAUNCH)
    const second = p.applyBatch(first.state, [], LAUNCH + 60)
    const third = p.applyBatch(second.state, [], LAUNCH + 720)
    expect(first.boundariesCrossed.map((c) => c.height)).toEqual([LAUNCH])
    expect(second.boundariesCrossed).toEqual([])
    expect(third.boundariesCrossed.map((c) => c.height)).toEqual([LAUNCH + 720])
  })

  it('does not re-emit it for a run resuming from a database that holds it', () => {
    // The restart that would otherwise derive a *different* commitment at the
    // same height: the log hash has been reseeded with the launch block's own
    // lines, so a second derivation is a divergence, not a duplicate.
    const { pipeline: p } = pipeline({ lastCheckpointHeight: LAUNCH })
    const state = initialState() // reloaded at LAUNCH, its checkpoint already written
    expect(p.applyBatch(state, [], LAUNCH + 60).boundariesCrossed).toEqual([])
    expect(p.applyBatch(state, [], LAUNCH + 720).boundariesCrossed.map((c) => c.height)).toEqual([LAUNCH + 720])
  })

  it('gives a LAUNCH_HEIGHT that is not a multiple no checkpoint of its own', () => {
    // The frozen LAUNCH_HEIGHT happens to be a multiple, so the off-boundary
    // case §8.1's wording still allows is emulated the way the constructor
    // computes it: a fresh start at launch `OFF_BOUNDARY` has
    // `lastBoundary = OFF_BOUNDARY - 1`, and an off-boundary launch height
    // never appears in the schedule.
    const { logger } = collectingLogger()
    const p = new Pipeline(CONFIG, logger, { lastCheckpointHeight: OFF_BOUNDARY - 1 })
    const state = Object.freeze({ ...initialState(), height: OFF_BOUNDARY })
    const result = p.applyBatch(state, [], OFF_BOUNDARY + 1_000)
    // The schedule is absolute, so the first boundary is the next multiple of
    // 720 — not `LAUNCH_HEIGHT + 720`.
    expect(result.boundariesCrossed.map((crossing) => crossing.height)).toEqual([LAUNCH + 720])
  })
})

describe('toChainTransaction', () => {
  it('throws rather than guessing a verdict for an unparseable address', () => {
    expect(() => toChainTransaction(candidate({ blockNumber: LAUNCH + 1, sender: 'NQ00 nope' }))).toThrow(
      /unparseable address/,
    )
  })
})
