import { describe, expect, it } from 'vitest'

import {
  CONSTANTS,
  commissionOn,
  encodeAuction,
  encodeBuy,
  encodeOffer,
  encodeRegister,
  encodeSettlement,
  feeFor,
  initialState,
  logFile,
  logHash,
  minPrice,
  type NnsConfig,
} from '@nns/core'

import {
  LAUNCH_HEIGHT,
  LOSER,
  MARKETPLACE,
  SELLER,
  TREASURY,
  WINNER,
  send,
  stageLog,
  testConfig,
} from './test-fixtures.js'
import { replayLog } from './replay.js'
import type { Fetcher, LogSnapshot } from './source.js'
import { createWatcher, obligationKey, takeSnapshot, WatchError } from './watch.js'
import { parseRateTable } from './rates.js'
import { createShareCollector, REBATE_KIND, SHARE_KIND } from './share.js'
import { testAddress } from './test-fixtures.js'

const config = testConfig()
const NAME = 'alicename'
const PRICE = 50_000_001n
const COMMISSION = commissionOn(PRICE, CONSTANTS.COMMISSION_RATE)
const PROCEEDS = PRICE - COMMISSION

const H = {
  register: LAUNCH_HEIGHT + 10,
  offer: LAUNCH_HEIGHT + 20,
  buy: LAUNCH_HEIGHT + 30,
  settle: LAUNCH_HEIGHT + 40,
} as const

/** Checkpoint boundaries: absolute multiples of `CHECKPOINT_INTERVAL`. */
const CP1 = LAUNCH_HEIGHT + CONSTANTS.CHECKPOINT_INTERVAL
const CP2 = CP1 + CONSTANTS.CHECKPOINT_INTERVAL

/** The full scenario: one sale (two legs), one race loser (one refund). */
function saleScenario(cfg: NnsConfig) {
  const fee = feeFor(NAME, initialState().prices)
  const floor = minPrice(initialState().prices)
  return [
    send(H.register, 0, SELLER, encodeRegister({ name: NAME, fee })),
    send(H.offer, 0, SELLER, encodeOffer({ name: NAME, price: PRICE, minPrice: floor })),
    send(H.buy, 0, WINNER, encodeBuy({ name: NAME, price: PRICE })),
    send(H.buy, 1, LOSER, encodeBuy({ name: NAME, price: PRICE })),
  ]
}

/** The same, with the seller's leg paid — the commission and refund still owed. */
function partlySettled(cfg: NnsConfig) {
  return [
    ...saleScenario(cfg),
    send(H.settle, 0, MARKETPLACE, encodeSettlement({ height: H.buy, txIndex: 0, payee: SELLER, amount: PROCEEDS })),
  ]
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

const snapshotOf = (lines: readonly string[], checkpointHeight: number, bound = true): LogSnapshot =>
  Object.freeze({ lines, checkpointHeight, logHash: hex(logHash(lines)), boundToCheckpoint: bound })

const replayOf = (lines: readonly string[], through: number = CP1) => replayLog(lines, initialState(), config, through)

// ── A stub API whose checkpoint and log can be moved between polls ───────────

interface ServerState {
  height: number | null
  lines: readonly string[]
}

function stubApi(state: ServerState): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = []
  const json = (status: number, body: unknown) => ({
    ok: status < 400,
    status,
    headers: { get: () => null },
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    text: () => Promise.resolve(JSON.stringify(body)),
  })

  const fetcher: Fetcher = (url: string) => {
    calls.push(url)
    if (url.endsWith('/checkpoints/latest')) {
      if (state.height === null) return Promise.resolve(json(404, { error: 'NO_CHECKPOINT', height: 0 }))
      return Promise.resolve(
        json(200, { checkpoint: { height: state.height, logHash: `0x${hex(logHash(state.lines))}` }, height: state.height }),
      )
    }
    if (url.endsWith('/log')) {
      const bytes = logFile(state.lines)
      const headers = new Map([
        ['x-nns-log-hash', `0x${hex(logHash(state.lines))}`],
        ['x-nns-checkpoint-height', String(state.height)],
      ])
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (name: string) => headers.get(name) ?? null },
        arrayBuffer: () =>
          Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer),
        text: () => Promise.resolve(''),
      })
    }
    // /checkpoints/{height}
    return Promise.resolve(
      json(200, { checkpoint: { height: state.height, logHash: `0x${hex(logHash(state.lines))}` }, height: state.height }),
    )
  }
  return { fetcher, calls }
}

const watcherOver = (fetcher: Fetcher) =>
  createWatcher({ apiUrl: 'https://api.example', config, fetcher, initial: initialState() })

// ── The due set ─────────────────────────────────────────────────────────────

describe('takeSnapshot', () => {
  it('finds the three legs a sale and a race loser owe, at the stamped height', () => {
    const lines = stageLog(saleScenario(config), config).lines
    const snapshot = takeSnapshot(snapshotOf(lines, CP1), replayOf(lines))

    expect(snapshot.checkpointHeight).toBe(CP1)
    // Sorted by (height, txIndex, kind): the winning B's two legs, then the
    // race loser's refund one index later.
    expect(snapshot.due.map((leg) => leg.kind)).toEqual(['COMMISSION', 'SALE_PROCEEDS', 'REFUND'])
    expect(snapshot.totalDue).toBe(PROCEEDS + COMMISSION + PRICE)
  })

  it('carries the sender each M must use — core decides it, not this package (§6 M)', () => {
    const lines = stageLog(saleScenario(config), config).lines
    const snapshot = takeSnapshot(snapshotOf(lines, CP1), replayOf(lines))

    for (const leg of snapshot.due) expect(leg.owedBy).toBe(MARKETPLACE)
    expect(snapshot.due.find((leg) => leg.kind === 'SALE_PROCEEDS')?.owedTo).toBe(SELLER)
    expect(snapshot.due.find((leg) => leg.kind === 'COMMISSION')?.owedTo).toBe(TREASURY)
    expect(snapshot.due.find((leg) => leg.kind === 'REFUND')?.owedTo).toBe(LOSER)
  })

  it('a refund is owed in full — never deducted from (§7.4)', () => {
    const lines = stageLog(saleScenario(config), config).lines
    const snapshot = takeSnapshot(snapshotOf(lines, CP1), replayOf(lines))
    expect(snapshot.due.find((leg) => leg.kind === 'REFUND')?.amount).toBe(PRICE)
  })

  it('a leg an M discharged is no longer due — idempotency comes from the log, not from memory', () => {
    const lines = stageLog(partlySettled(config), config).lines
    const snapshot = takeSnapshot(snapshotOf(lines, CP1), replayOf(lines))

    expect(snapshot.due.map((leg) => leg.kind).sort()).toEqual(['COMMISSION', 'REFUND'])
    expect(snapshot.due.some((leg) => leg.kind === 'SALE_PROCEEDS')).toBe(false)
    expect(snapshot.totalDue).toBe(COMMISSION + PRICE)
  })

  it('keys a leg by (ref, kind), which is unique across the two legs of one sale', () => {
    const lines = stageLog(saleScenario(config), config).lines
    const snapshot = takeSnapshot(snapshotOf(lines, CP1), replayOf(lines))

    expect(snapshot.due.map((leg) => leg.key)).toEqual([
      `${H.buy}:0:COMMISSION`,
      `${H.buy}:0:SALE_PROCEEDS`,
      `${H.buy}:1:REFUND`,
    ])
    expect(new Set(snapshot.due.map((leg) => leg.key)).size).toBe(snapshot.due.length)
  })

  it('ages a leg against the checkpoint, not against a clock', () => {
    const lines = stageLog(saleScenario(config), config).lines
    const early = takeSnapshot(snapshotOf(lines, CP1), replayOf(lines))
    const later = takeSnapshot(snapshotOf(lines, CP2), replayOf(lines, CP2))

    const age = (s: typeof early): number => s.due[0]?.ageBlocks ?? -1
    expect(age(early)).toBe(CP1 - H.buy)
    expect(age(later)).toBe(CP2 - H.buy)
  })

  it('applies no confirmation depth — every leg at or below the stamp is due', () => {
    // The buy is 690 blocks under the boundary; a watcher that held back
    // "recent" obligations would report nothing here, and be wrong to.
    const lines = stageLog(saleScenario(config), config).lines
    expect(CP1 - H.buy).toBeLessThan(CONSTANTS.CHECKPOINT_INTERVAL)
    expect(takeSnapshot(snapshotOf(lines, CP1), replayOf(lines)).due).toHaveLength(3)
  })

  it('reports an M that discharged nothing without withholding what is still owed (§6 M)', () => {
    const lines = stageLog(
      [
        ...saleScenario(config),
        // Names a transaction that owes nothing: money moved, no leg cleared.
        send(H.settle, 0, MARKETPLACE, encodeSettlement({ height: H.register, txIndex: 0, payee: SELLER, amount: 1n })),
      ],
      config,
    ).lines
    const snapshot = takeSnapshot(snapshotOf(lines, CP1), replayOf(lines))

    expect(snapshot.unmatched).toHaveLength(1)
    expect(snapshot.due).toHaveLength(3)
  })
})

// ── The three refusals ──────────────────────────────────────────────────────

describe('takeSnapshot — auctions (r28)', () => {
  const STARTING_PRICE = PRICE
  const WINNING = STARTING_PRICE + commissionOn(STARTING_PRICE, CONSTANTS.AUCTION_MIN_INCREMENT_BP)
  const HA = { open: LAUNCH_HEIGHT + 20, first: LAUNCH_HEIGHT + 30, outbid: LAUNCH_HEIGHT + 31 } as const
  const END = HA.open + CONSTANTS.AUCTION_MIN_DURATION
  /** The first checkpoint boundary at or past the end height. */
  const CLOSE_CP = Math.ceil(END / CONSTANTS.CHECKPOINT_INTERVAL) * CONSTANTS.CHECKPOINT_INTERVAL
  const auction = () => {
    const fee = feeFor(NAME, initialState().prices)
    const floor = minPrice(initialState().prices)
    return [
      send(H.register, 0, SELLER, encodeRegister({ name: NAME, fee })),
      send(HA.open, 0, SELLER, encodeAuction({ name: NAME, startingPrice: STARTING_PRICE, endHeight: END, minPrice: floor })),
      send(HA.first, 0, LOSER, encodeBuy({ name: NAME, price: STARTING_PRICE })),
      send(HA.outbid, 0, WINNER, encodeBuy({ name: NAME, price: WINNING })),
    ]
  }

  it('owes the outbid bidder at the checkpoint that passes the outbidding B, and the close at the one that passes the end', () => {
    const { lines } = stageLog(auction(), config)
    const open = takeSnapshot(snapshotOf(lines, CP1), replayOf(lines, CP1))
    expect(open.due.map((leg) => leg.key)).toEqual([`${HA.first}:0:REFUND`])
    expect(open.due[0]).toMatchObject({ owedBy: MARKETPLACE, owedTo: LOSER, amount: STARTING_PRICE })

    // No line after the bid: the close is a height effect, and the due set
    // has to grow across a checkpoint the log did not gain a line at.
    const closed = takeSnapshot(snapshotOf(lines, CLOSE_CP), replayOf(lines, CLOSE_CP))
    expect(closed.due.map((leg) => leg.key)).toEqual([
      `${HA.first}:0:REFUND`,
      `${HA.outbid}:0:COMMISSION`,
      `${HA.outbid}:0:SALE_PROCEEDS`,
    ])
    const commission = commissionOn(WINNING, CONSTANTS.COMMISSION_RATE)
    expect(closed.due[1]).toMatchObject({ owedBy: MARKETPLACE, owedTo: TREASURY, amount: commission })
    expect(closed.due[2]).toMatchObject({ owedBy: MARKETPLACE, owedTo: SELLER, amount: WINNING - commission })
    expect(closed.totalDue).toBe(STARTING_PRICE + WINNING)
  })
})

describe('takeSnapshot refuses to derive a payment from', () => {
  const lines = stageLog(saleScenario(config), config).lines

  it('a log not bound to its checkpoint — there is no honest reason to pay from unbound bytes', () => {
    expect(() => takeSnapshot(snapshotOf(lines, CP1, false), replayOf(lines))).toThrow(WatchError)
    expect(() => takeSnapshot(snapshotOf(lines, CP1, false), replayOf(lines))).toThrow(/not bound to that checkpoint/)
  })

  it('a log whose verdicts disagree with the replay (§7.4)', () => {
    const replay = replayOf(lines)
    const tampered = {
      ...replay,
      mismatches: [{ at: { height: H.buy, txIndex: 1 }, logged: 'REFUND', replayed: 'FORFEIT' }],
    }
    expect(() => takeSnapshot(snapshotOf(lines, CP1), tampered)).toThrow(/disagree with the replay/)
  })

  it('a replay whose legs do not balance', () => {
    const replay = replayOf(lines)
    // Drop one outstanding leg while leaving it in `created`: created ≠
    // settled + outstanding, and the due set would silently be one leg short.
    const short = { ...replay, outstanding: replay.outstanding.slice(1) }
    expect(() => takeSnapshot(snapshotOf(lines, CP1), short)).toThrow(/does not balance/)
  })

  it('two outstanding legs sharing one idempotency key', () => {
    const replay = replayOf(lines)
    const [first] = replay.outstanding
    if (first === undefined) throw new Error('fixture has no outstanding leg')
    const doubled = { ...replay, outstanding: [first, first] }
    expect(() => takeSnapshot(snapshotOf(lines, CP1), doubled)).toThrow(/share the key/)
  })
})

describe('takeSnapshot — the §10.7 share (policy, beside the reducer’s legs)', () => {
  const REFERRER_OWNER = testAddress(20)
  const RATES = parseRateTable({ rates: [{ ref: null, bp: 1000, fromHeight: 0 }] })
  const referrerFee = feeFor('ricoref', initialState().prices)
  const newcomerFee = feeFor('newcomer', initialState().prices)
  const SHARE = (newcomerFee * 1000n) / 10_000n
  const referred = [
    send(H.register, 0, REFERRER_OWNER, encodeRegister({ name: 'ricoref', fee: referrerFee })),
    send(H.offer, 0, WINNER, encodeRegister({ name: 'newcomer', fee: newcomerFee, ref: 'ricoref' })),
  ]
  const withShares = (sends: typeof referred) => {
    const staged = stageLog(sends, config)
    const collector = createShareCollector(RATES)
    const replay = replayLog(staged.lines, initialState(), config, CP1, collector.observe)
    return takeSnapshot(snapshotOf(staged.lines, CP1), replay, collector.result())
  }

  it('lists the share as due from the treasury, under its own kind and key', () => {
    const snapshot = withShares(referred)
    expect(snapshot.due).toHaveLength(1)
    expect(snapshot.due[0]).toMatchObject({
      key: `${H.offer}:0:${SHARE_KIND}`,
      kind: SHARE_KIND,
      owedBy: TREASURY,
      owedTo: REFERRER_OWNER,
      amount: SHARE,
    })
    expect(snapshot.totalDue).toBe(SHARE)
  })

  it('without a table the same log owes no share — the reducer never created one', () => {
    const staged = stageLog(referred, config)
    expect(takeSnapshot(snapshotOf(staged.lines, CP1), replayOf(staged.lines)).due).toEqual([])
  })

  it('a treasury M that paid the share is neither due nor an unmatched settlement', () => {
    const paid = [
      ...referred,
      send(H.buy, 0, TREASURY, encodeSettlement({ height: H.offer, txIndex: 0, payee: REFERRER_OWNER, amount: SHARE })),
    ]
    const snapshot = withShares(paid)
    expect(snapshot.due).toEqual([])
    expect(snapshot.unmatched).toEqual([])
  })

  // One referral, two payouts: the issuer has to be handed both, under two
  // keys, or half the programme never leaves the treasury.
  describe('and the buyer’s rebate beside it', () => {
    const SPLIT = parseRateTable({ rates: [{ ref: null, bp: 400, rebateBp: 400, selfBp: 0, fromHeight: 0 }] })
    const NET = (newcomerFee * 400n) / 10_000n
    const split = (sends: typeof referred) => {
      const staged = stageLog(sends, config)
      const collector = createShareCollector(SPLIT)
      const replay = replayLog(staged.lines, initialState(), config, CP1, collector.observe)
      return takeSnapshot(snapshotOf(staged.lines, CP1), replay, collector.result())
    }

    it('both payouts are due, under two keys, to two payees', () => {
      const snapshot = split(referred)
      expect(snapshot.due.map((leg) => [leg.key, leg.kind, leg.owedTo, leg.amount])).toEqual([
        [`${H.offer}:0:${REBATE_KIND}`, REBATE_KIND, WINNER, NET],
        [`${H.offer}:0:${SHARE_KIND}`, SHARE_KIND, REFERRER_OWNER, NET],
      ])
      expect(snapshot.due.every((leg) => leg.owedBy === TREASURY)).toBe(true)
      expect(snapshot.totalDue).toBe(NET * 2n)
    })

    it('paying one leaves the other due', () => {
      const snapshot = split([
        ...referred,
        send(H.buy, 0, TREASURY, encodeSettlement({ height: H.offer, txIndex: 0, payee: WINNER, amount: NET })),
      ])
      expect(snapshot.due.map((leg) => leg.kind)).toEqual([SHARE_KIND])
      expect(snapshot.unmatched).toEqual([])
    })

    it('paying both leaves nothing due and nothing unexplained', () => {
      const snapshot = split([
        ...referred,
        send(H.buy, 0, TREASURY, encodeSettlement({ height: H.offer, txIndex: 0, payee: REFERRER_OWNER, amount: NET })),
        send(H.buy, 1, TREASURY, encodeSettlement({ height: H.offer, txIndex: 0, payee: WINNER, amount: NET })),
      ])
      expect(snapshot.due).toEqual([])
      expect(snapshot.unmatched).toEqual([])
      expect(snapshot.mispaidShares).toEqual([])
      expect(snapshot.unpricedShares).toEqual([])
    })
  })

  it('createWatcher pays shares only when handed a table', async () => {
    const staged = stageLog(referred, config)
    const server = { height: CP1, lines: staged.lines }
    const plain = await watcherOver(stubApi(server).fetcher).poll()
    expect(plain.kind === 'snapshot' && plain.snapshot.due).toEqual([])
    const withTable = createWatcher({ apiUrl: 'https://api.example', config, fetcher: stubApi(server).fetcher, initial: initialState(), rates: RATES })
    const result = await withTable.poll()
    expect(result.kind === 'snapshot' && result.snapshot.due.map((leg) => leg.kind)).toEqual([SHARE_KIND])
  })
})

describe('obligationKey', () => {
  it('is <height>:<txIndex>:<KIND>', () => {
    const lines = stageLog(saleScenario(config), config).lines
    const [leg] = replayOf(lines).outstanding
    if (leg === undefined) throw new Error('fixture has no outstanding leg')
    expect(obligationKey(leg.obligation)).toBe(`${leg.obligation.ref.height}:${leg.obligation.ref.txIndex}:${leg.obligation.kind}`)
  })
})

// ── Polling ─────────────────────────────────────────────────────────────────

describe('createWatcher', () => {
  it('reports no-checkpoint before the indexer reaches its first boundary', async () => {
    const { fetcher } = stubApi({ height: null, lines: [] })
    expect(await watcherOver(fetcher).poll()).toEqual({ kind: 'no-checkpoint' })
  })

  it('fetches the log once and then answers unchanged without refetching it', async () => {
    const state: ServerState = { height: CP1, lines: stageLog(saleScenario(config), config).lines }
    const { fetcher, calls } = stubApi(state)
    const watcher = watcherOver(fetcher)

    const first = await watcher.poll()
    expect(first.kind).toBe('snapshot')
    expect(calls.filter((url) => url.endsWith('/log'))).toHaveLength(1)

    const second = await watcher.poll()
    expect(second).toEqual({ kind: 'unchanged', checkpointHeight: CP1 })
    // `/log` is served through the latest checkpoint, so an unmoved height
    // cannot hide new lines — and the file is never pulled twice for nothing.
    expect(calls.filter((url) => url.endsWith('/log'))).toHaveLength(1)
    expect(watcher.lastSeen).toBe(CP1)
  })

  it('picks up a leg settled between two checkpoints', async () => {
    const state: ServerState = { height: CP1, lines: stageLog(saleScenario(config), config).lines }
    const { fetcher } = stubApi(state)
    const watcher = watcherOver(fetcher)

    const before = await watcher.poll()
    expect(before.kind === 'snapshot' && before.snapshot.due).toHaveLength(3)

    state.height = CP2
    state.lines = stageLog(partlySettled(config), config).lines
    const after = await watcher.poll()
    expect(after.kind === 'snapshot' && after.snapshot.due.map((leg) => leg.kind).sort()).toEqual([
      'COMMISSION',
      'REFUND',
    ])
  })

  it('refuses a server whose checkpoint went backwards — a rewind can resurrect a paid debt', async () => {
    const state: ServerState = { height: CP2, lines: stageLog(partlySettled(config), config).lines }
    const { fetcher } = stubApi(state)
    const watcher = watcherOver(fetcher)
    await watcher.poll()

    state.height = CP1
    state.lines = stageLog(saleScenario(config), config).lines
    await expect(watcher.poll()).rejects.toThrow(/went backwards/)
  })

  it('refuses a different log at a height already seen, on the cheap leg of the poll', async () => {
    const state: ServerState = { height: CP1, lines: stageLog(saleScenario(config), config).lines }
    const { fetcher, calls } = stubApi(state)
    const watcher = watcherOver(fetcher)
    await watcher.poll()
    const fetchesBefore = calls.filter((url) => url.endsWith('/log')).length

    // The height does not move; the bytes do. A watcher comparing heights
    // alone would answer "unchanged" and never look.
    state.lines = stageLog(partlySettled(config), config).lines
    await expect(watcher.poll()).rejects.toThrow(/a fork, not an update/)
    expect(calls.filter((url) => url.endsWith('/log'))).toHaveLength(fetchesBefore)
  })
})
