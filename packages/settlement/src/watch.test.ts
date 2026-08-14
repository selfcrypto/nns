import { describe, expect, it } from 'vitest'

import {
  CONSTANTS,
  commissionOn,
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
  const fee = feeFor(NAME, initialState(cfg).prices)
  const floor = minPrice(initialState(cfg).prices)
  return [
    send(H.register, 0, SELLER, encodeRegister(cfg, { name: NAME, fee })),
    send(H.offer, 0, SELLER, encodeOffer(cfg, { name: NAME, price: PRICE, minPrice: floor })),
    send(H.buy, 0, WINNER, encodeBuy(cfg, { name: NAME, price: PRICE })),
    send(H.buy, 1, LOSER, encodeBuy(cfg, { name: NAME, price: PRICE })),
  ]
}

/** The same, with the seller's leg paid — the commission and refund still owed. */
function partlySettled(cfg: NnsConfig) {
  return [
    ...saleScenario(cfg),
    send(H.settle, 0, MARKETPLACE, encodeSettlement(cfg, { height: H.buy, txIndex: 0, payee: SELLER, amount: PROCEEDS })),
  ]
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

const snapshotOf = (lines: readonly string[], checkpointHeight: number, bound = true): LogSnapshot =>
  Object.freeze({ lines, checkpointHeight, logHash: hex(logHash(lines)), boundToCheckpoint: bound })

const replayOf = (lines: readonly string[]) => replayLog(lines, initialState(config), config)

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
  createWatcher({ apiUrl: 'https://api.example', config, fetcher, initial: initialState(config) })

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
    const later = takeSnapshot(snapshotOf(lines, CP2), replayOf(lines))

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
        send(H.settle, 0, MARKETPLACE, encodeSettlement(config, { height: H.register, txIndex: 0, payee: SELLER, amount: 1n })),
      ],
      config,
    ).lines
    const snapshot = takeSnapshot(snapshotOf(lines, CP1), replayOf(lines))

    expect(snapshot.unmatched).toHaveLength(1)
    expect(snapshot.due).toHaveLength(3)
  })
})

// ── The three refusals ──────────────────────────────────────────────────────

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
