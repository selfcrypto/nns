import {
  CONSTANTS,
  feeFor,
  LAUNCH_PRICES,
  checkpoint as coreCheckpoint,
  defineConfig,
  initialState,
  logHash,
  parseAddress,
  type NameRecord,
  type NnsState,
} from '@nimiqnames/core'
import { describe, expect, it } from 'vitest'

import {
  CheckpointBuilder,
  CheckpointError,
  COMMITMENT_LAYOUT,
  checkpointRow,
  commitmentFor,
  hex,
  logLineFromRow,
} from './checkpoint.js'
import { Pipeline } from './pipeline.js'
import type { LogRow } from './rows.js'
import type { NnsCandidate } from './scan.js'
import { collectingLogger, payload } from './test-fixtures.js'

const A = 'NQ39 M3TJ 2NC1 G4PJ 07JF BFKG Q3X6 AK7K J7YT' // CONSTANTS.TREASURY_ADDRESS, spaced as the RPC prints it
const B = 'NQ91 SQRC L91X D5QK 6A21 1UV7 11EY 7YA3 BBRT' // CONSTANTS.PROTOCOL_ADDRESS
const C = 'NQ95 0MNS X5BJ 3SMV XA2E 7059 BU9F AXX6 J4MX' // CONSTANTS.ADMIN_ADDRESS
const D = 'NQ55 SY33 7HS4 DP5N H9P0 9PMG 7MD8 PTL8 N2P5' // CONSTANTS.MARKETPLACE_ADDRESS

const LAUNCH = CONSTANTS.LAUNCH_HEIGHT // a multiple of CHECKPOINT_INTERVAL, so boundaries read easily
const INTERVAL = CONSTANTS.CHECKPOINT_INTERVAL

const CONFIG = defineConfig({ networkId: 24 })

const compact = (value: string) => parseAddress(value)

/**
 * A builder and a pipeline that has already emitted the boundary at `LAUNCH`.
 *
 * `LAUNCH` is a multiple of the interval, so §8.1 puts a checkpoint there —
 * `pipeline.ts` owns that rule and `pipeline.test.ts` covers it. Starting these
 * tests past it keeps them about the builder: which state a boundary commits,
 * and which log lines its hash covers.
 */
function builder() {
  const { logger, lines } = collectingLogger()
  return {
    builder: new CheckpointBuilder({ logger }),
    pipeline: new Pipeline(CONFIG, logger, { lastCheckpointHeight: LAUNCH }),
    lines,
  }
}

function candidate(overrides: Partial<NnsCandidate> & { blockNumber: number }): NnsCandidate {
  return {
    txIndex: 0,
    hash: 'ab'.repeat(32),
    sender: 'NQ64 VFXQ TPAS 5Q7S ADEX 072S CR2M QCQ4 8P8M',
    recipient: A, // the treasury takes the fee
    value: feeFor('testname', LAUNCH_PRICES),
    fee: 0n,
    recipientData: payload('NNS1Gtestname'),
    networkId: 24,
    executionResult: true,
    timestamp: 1_700_000_000,
    ...overrides,
  }
}

function logRow(overrides: Partial<LogRow> = {}): LogRow {
  return {
    block_height: LAUNCH + 10,
    tx_index: 0,
    tx_hash: 'ab'.repeat(32),
    sender: compact(A),
    recipient: compact(B),
    value: '400000000',
    data: payload('NNS1Gtestname'),
    verdict: 'OK',
    ...overrides,
  }
}

describe('logLineFromRow', () => {
  it('is the exact line the pipeline split into columns', () => {
    // The pipeline builds a row by splitting `core.canonicalLogLine`; joining
    // the columns back has to be the identity, or the committed hash is over
    // bytes no replayer produces.
    const { pipeline: p } = builder()
    const result = p.applyBatch(initialState(), [candidate({ blockNumber: LAUNCH + 10 })], LAUNCH + 60)
    const row = result.logRows[0] as LogRow
    expect(logLineFromRow(row)).toBe(
      [LAUNCH + 10, 0, 'ab'.repeat(32), compact(candidate({ blockNumber: 0 }).sender), compact(A),
        feeFor('testname', LAUNCH_PRICES).toString(10), payload('NNS1Gtestname'), 'OK'].join(' '),
    )
  })

  it('yields eight space-separated fields', () => {
    expect(logLineFromRow(logRow()).split(' ')).toHaveLength(8)
  })
})

describe('commitmentFor', () => {
  it('delegates to core, byte for byte', () => {
    const state = initialState()
    const hash = logHash([])
    expect(commitmentFor(state, LAUNCH, hash)).toEqual(coreCheckpoint(state, hash))
  })

  it('refuses a state that is not current as of the checkpoint height', () => {
    // `core.checkpoint` takes the height from the state, so a mismatch here
    // would commit silently at the wrong height rather than fail.
    expect(() => commitmentFor(initialState(), LAUNCH + INTERVAL, logHash([]))).toThrow(CheckpointError)
  })
})

describe('CheckpointBuilder', () => {
  it('commits at every boundary a batch crosses, at that boundary’s state', () => {
    const { builder: b, pipeline: p } = builder()
    const result = p.applyBatch(initialState(), [], LAUNCH + 2 * INTERVAL)
    const records = b.buildForBatch(result)

    expect(records.map((record) => record.height)).toEqual([LAUNCH + INTERVAL, LAUNCH + 2 * INTERVAL])
    for (const record of records) {
      expect(record.nameRoot).toHaveLength(32)
      expect(record.commitment).toHaveLength(32)
    }
  })

  it('commits nothing when no boundary is crossed', () => {
    // No real batch is quiet since the interval became one batch (every macro
    // block is a boundary); a partial advance is what still crosses none.
    const { builder: b, pipeline: p } = builder()
    expect(b.buildForBatch(p.applyBatch(initialState(), [], LAUNCH + INTERVAL / 2))).toEqual([])
  })

  it('covers exactly the log lines at or below the checkpoint height', () => {
    // The line that matters: a message *after* the boundary must not be in the
    // hash the boundary commits, even though both land in the same batch.
    const { builder: b, pipeline: p } = builder()
    const before = candidate({
      blockNumber: LAUNCH + INTERVAL - 10,
      recipientData: payload('NNS1Gearlyname'),
    })
    const after = candidate({
      blockNumber: LAUNCH + INTERVAL + 10,
      recipientData: payload('NNS1Glatername'),
    })
    const result = p.applyBatch(initialState(), [before, after], LAUNCH + INTERVAL + 30)

    expect(result.boundariesCrossed.map((crossing) => crossing.logRowsBefore)).toEqual([1])
    const [record] = b.buildForBatch(result)
    expect(record?.height).toBe(LAUNCH + INTERVAL)
    expect(record?.logHash).toEqual(logHash([logLineFromRow(result.logRows[0] as LogRow)]))
    // …and the later line is folded in afterwards, ready for the next one.
    expect(b.lines).toBe(2)
    expect(b.logHash).toEqual(logHash(result.logRows.map(logLineFromRow)))
  })

  it('commits a name registered before the boundary, and not one after it', () => {
    const { builder: b, pipeline: p } = builder()
    const result = p.applyBatch(
      initialState(),
      [
        candidate({ blockNumber: LAUNCH + INTERVAL - 10, recipientData: payload('NNS1Gearlyname') }),
        candidate({ blockNumber: LAUNCH + INTERVAL + 10, recipientData: payload('NNS1Glatername') }),
      ],
      LAUNCH + 2 * INTERVAL,
    )
    const [first, second] = b.buildForBatch(result)
    expect(first?.height).toBe(LAUNCH + INTERVAL)
    expect(second?.height).toBe(LAUNCH + 2 * INTERVAL)
    expect(first?.nameRoot).not.toEqual(second?.nameRoot)
  })

  it('reaches the same roots whatever the batch split — the replay property', () => {
    // Deliverable 5's "done when": a second run from empty must produce
    // byte-identical roots. Splitting the same messages across different
    // batches is the sharpest form of that, because it changes every
    // intermediate the builder holds without changing the chain.
    const messages = [
      candidate({ blockNumber: LAUNCH + 10, recipientData: payload('NNS1Gfirstname') }),
      candidate({ blockNumber: LAUNCH + INTERVAL + 20, recipientData: payload('NNS1Gsecondname') }),
      candidate({ blockNumber: LAUNCH + 2 * INTERVAL + 40, recipientData: payload('NNS1Gthirdname') }),
    ]
    const through = LAUNCH + 3 * INTERVAL

    const whole = builder()
    const together = whole.builder.buildForBatch(
      whole.pipeline.applyBatch(initialState(), messages, through),
    )

    const split = builder()
    let state = initialState()
    const apart = []
    for (const [index, message] of messages.entries()) {
      // Each split batch ends ten blocks short of the next boundary, so the
      // apart run crosses each boundary in a different call from the whole run.
      const step = split.pipeline.applyBatch(state, [message], LAUNCH + INTERVAL * (index + 1) - 10)
      state = step.state
      apart.push(...split.builder.buildForBatch(step))
    }
    apart.push(...split.builder.buildForBatch(split.pipeline.applyBatch(state, [], through)))

    expect(together).toHaveLength(3) // …so the comparison below is not vacuous
    expect(apart.map((record) => hex(record.commitment))).toEqual(together.map((record) => hex(record.commitment)))
  })

  it('resumes from a seeded log to the same hash as an uninterrupted run', () => {
    // The restart path: state is reloaded from the tables, but the log hash is
    // a fold over every line ever written and has to be rebuilt from the `log`
    // table. A resumed run whose hash differs commits roots nobody can check.
    const rows = [logRow(), logRow({ block_height: LAUNCH + 20, tx_index: 2, verdict: 'INVALID_NAME' })]
    const straight = builder().builder
    for (const row of rows) straight.seed(row)

    const resumed = builder().builder
    for (const row of rows) resumed.seed(row)

    expect(hex(resumed.logHash)).toBe(hex(straight.logHash))
    expect(resumed.logHash).toEqual(logHash(rows.map(logLineFromRow)))
    expect(resumed.lines).toBe(2)
  })

  it('refuses log rows out of canonical order', () => {
    const b = builder().builder
    b.seed(logRow({ block_height: LAUNCH + 20, tx_index: 1 }))
    expect(() => b.seed(logRow({ block_height: LAUNCH + 20, tx_index: 1 }))).toThrow(/order-dependent/)
    expect(() => b.seed(logRow({ block_height: LAUNCH + 10 }))).toThrow(CheckpointError)
  })

  it('refuses to seed once a checkpoint has been built', () => {
    const { builder: b, pipeline: p } = builder()
    b.buildForBatch(p.applyBatch(initialState(), [], LAUNCH + INTERVAL))
    expect(() => b.seed(logRow({ block_height: LAUNCH + INTERVAL + 1 }))).toThrow(/after a checkpoint/)
  })

  it('logs each checkpoint it builds', () => {
    const { builder: b, pipeline: p, lines } = builder()
    b.buildForBatch(p.applyBatch(initialState(), [], LAUNCH + INTERVAL))
    const built = lines.filter((line) => line['msg'] === 'checkpoint.built')
    expect(built).toHaveLength(1)
    expect(built[0]).toMatchObject({ height: LAUNCH + INTERVAL, layout: COMMITMENT_LAYOUT })
    expect(String(built[0]?.['commitment'])).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('checkpointRow', () => {
  it('carries every component of the commitment, and its layout', () => {
    // Every one, including r16's `unreservedRoot` (migration 003). The
    // per-component columns are what turn a divergence into a *localised*
    // divergence, and the unreserved set is the component whose absence from
    // the commitment caused this whole episode.
    const { builder: b, pipeline: p } = builder()
    const [record] = b.buildForBatch(p.applyBatch(initialState(), [], LAUNCH + INTERVAL))
    const row = checkpointRow(record as NonNullable<typeof record>)
    expect(row.height).toBe(LAUNCH + INTERVAL)
    expect(row.layout).toBe(COMMITMENT_LAYOUT)
    const columns = ['name_root', 'prices_root', 'pending_root', 'unreserved_root', 'log_hash', 'commitment'] as const
    for (const column of columns) {
      expect(Buffer.isBuffer(row[column])).toBe(true)
      expect(row[column]).toHaveLength(32)
    }
  })
})

describe('an open auction is committed — r28 §8.1, tag 0x0B', () => {
  // The r16 bug class, guarded for the newest pending category: two indexers
  // that disagree about whether an auction is open, or who holds the standing
  // bid, must not derive the same commitment. Only `pending_root` may carry
  // the difference — a bid moves no leaf.
  const base = Object.freeze({ ...initialState(), height: LAUNCH + INTERVAL })
  const auction = { name: 'nimiq', seller: compact(A), startingPrice: 100_000n, endHeight: base.height + 90_000, bidder: null, bid: 0n, bidRef: null }
  const open = Object.freeze({ ...base, auctions: new Map([['nimiq', auction]]) })
  const withBid = Object.freeze({
    ...base,
    auctions: new Map([['nimiq', { ...auction, bidder: compact(D), bid: 100_000n, bidRef: { height: base.height - 1, txIndex: 0 } }]]),
  })
  const higherBid = Object.freeze({
    ...base,
    auctions: new Map([['nimiq', { ...auction, bidder: compact(D), bid: 105_000n, bidRef: { height: base.height - 1, txIndex: 0 } }]]),
  })
  const components = (state: NnsState) => commitmentFor(state, base.height, logHash([]))
  const commit = (state: NnsState) => hex(components(state).commitment)

  it('commits differently once an A opens, once a bid stands, and once the bid changes', () => {
    expect(commit(open)).not.toBe(commit(base))
    expect(commit(withBid)).not.toBe(commit(open))
    expect(commit(higherBid)).not.toBe(commit(withBid))
  })

  it('carries the difference in pending_root alone', () => {
    expect(hex(components(open).pendingRoot)).not.toBe(hex(components(base).pendingRoot))
    expect(hex(components(withBid).pendingRoot)).not.toBe(hex(components(open).pendingRoot))
    for (const s of [open, withBid, higherBid]) {
      expect(hex(components(s).nameRoot)).toBe(hex(components(base).nameRoot))
      expect(hex(components(s).unreservedRoot)).toBe(hex(components(base).unreservedRoot))
      expect(hex(components(s).pricesRoot)).toBe(hex(components(base).pricesRoot))
    }
  })
})

describe('the unreserved set is committed — r16 §8.1, tag 0x0A', () => {
  // Through r15, §8.1 committed a *pending* `U` (tag 0x09) but not a fired one,
  // so two indexers that disagreed about which reserved names had been released
  // derived identical roots and different registries. This block asserted that
  // gap until core landed 0x0A, which is what made it fail and say why; it now
  // asserts the fix from the one place in this package that calls core.
  const withName = (state: NnsState, record: NameRecord): NnsState =>
    Object.freeze({ ...state, names: new Map([[record.name, record]]) })

  const base = Object.freeze({ ...initialState(), height: LAUNCH + INTERVAL })
  /** The same name, in the two states the commitment has to tell apart. */
  const released = Object.freeze({ ...base, unreserved: new Set(['nimiq']) })
  const commit = (state: NnsState) => hex(commitmentFor(state, base.height, logHash([])).commitment)

  it('commits differently once a `U` has fired', () => {
    expect(commit(released)).not.toBe(commit(base))
  })

  it('separates a fired award from a fired release — r22, no pending form left', () => {
    // Through r21 this pair was *pending*: two states that agreed a `U` was
    // scheduled and disagreed about who the name went to, separated by the
    // 20-byte recipient inside tag 0x09. r22 made a `U` execute in its landing
    // block, so there is no pending form and the disagreement is settled the
    // moment it exists — by the name tree, since an award writes a leaf and a
    // release does not, while both join `unreserved` identically.
    //
    // The seam this block exists for is unchanged: an indexer that mistook one
    // for the other must not derive the same commitment.
    const awarded = withName(released, {
      name: 'nimiq',
      owner: compact(D),
      target: compact(D),
      expiry: base.height + 31_536_000,
      status: 'REGISTERED',
      evm: '',
      host: '',
    })
    expect(commit(awarded)).not.toBe(commit(released))
    // …and `unreserved_root` is *not* what tells them apart: tag 0x0A records
    // only that the name left RESERVED_NAMES, never who to (§8.1).
    const componentsOf = (state: NnsState) => commitmentFor(state, base.height, logHash([]))
    expect(hex(componentsOf(awarded).unreservedRoot)).toBe(hex(componentsOf(released).unreservedRoot))
    expect(hex(componentsOf(awarded).nameRoot)).not.toBe(hex(componentsOf(released).nameRoot))
  })

  it('has no pending category a `U` can reach — the pending root is empty either way', () => {
    // The byte claim r22 rests on, asserted where this package would notice:
    // a fired `U`, release or award, leaves the pending set exactly as it
    // found it, so `pending_root` at a checkpoint over such a state is the
    // empty form. A reducer that resurrected a pending `U` would break this
    // before it broke any root comparison.
    const empty = hex(commitmentFor(base, base.height, logHash([])).pendingRoot)
    expect(hex(commitmentFor(released, base.height, logHash([])).pendingRoot)).toBe(empty)
  })

  it('also moves the tree once the released name is registered', () => {
    // The path that was the only visibility under r15, and the reason the gap
    // mattered: it fires when somebody registers the name, which is one
    // registration too late to catch a divergence about whether they could.
    const record: NameRecord = {
      name: 'nimiq',
      owner: compact(A),
      target: compact(A),
      expiry: LAUNCH + 100_000,
      status: 'REGISTERED',
      evm: '',
      host: '',
    }
    expect(commit(withName(base, record))).not.toBe(commit(base))
  })
})
