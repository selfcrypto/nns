/**
 * Bootstrap round trip — **needs a real Postgres**, and is skipped without one.
 *
 *   NNS_TEST_DATABASE_URL=postgres://…/nns_test pnpm vitest run --project indexer
 *
 * The whole point of the mode is what ends up in the tables, so mocking the
 * store would test the one half that cannot be wrong. This suite owns its own
 * schema, for the reason `store.test.ts` explains at length.
 */

import {
  advanceTo,
  checkpoint as coreCheckpoint,
  CONSTANTS,
  encodeRegister,
  feeFor,
  initialState,
  logFile,
  logHash,
  type NnsState,
} from '@nns/core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { bootstrap, BootstrapError } from './bootstrap.js'
import { BLOCKS_PER_BATCH } from './chain.js'
import { checkpointRow, hex } from './checkpoint.js'
import { createPool, migrate } from './db.js'
import type { Fetcher } from './peer.js'
import { Store } from './store.js'
import {
  collectingLogger,
  fakeNode,
  LAUNCH_HEIGHT,
  SELLER,
  send,
  stageLog,
  testConfig,
  type StagedLog,
} from './test-fixtures.js'

const URL_ = process.env['NNS_TEST_DATABASE_URL']
const SCHEMA = 'bootstrap_test'
const POOL_URL =
  URL_ === undefined
    ? ''
    : `${URL_}${URL_.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`

const CONFIG = testConfig()
const INTERVAL = CONSTANTS.CHECKPOINT_INTERVAL

// The fake chain's genesis is chosen so LAUNCH_HEIGHT lands on a batch
// boundary and the arithmetic below reads as itself. Everything else follows:
// batches are 60 blocks, §8.1 boundaries are absolute multiples of
// CHECKPOINT_INTERVAL, and the bootstrap stops one batch below the peer's.
const GENESIS = LAUNCH_HEIGHT - BLOCKS_PER_BATCH
/** The peer's checkpoint: a boundary far enough above launch to leave a range. */
const PEER_HEIGHT = (Math.floor(LAUNCH_HEIGHT / INTERVAL) + 4) * INTERVAL

const staged: StagedLog = stageLog(
  [
    send(LAUNCH_HEIGHT + 5, 0, SELLER, encodeRegister({ name: 'alicename', fee: feeFor('alicename', initialState().prices) })),
    send(LAUNCH_HEIGHT + 65, 0, SELLER, encodeRegister({ name: 'bobsname', fee: feeFor('bobsname', initialState().prices) })),
  ],
  CONFIG,
)

const digest = (bytes: Uint8Array): string => hex(bytes)

/**
 * A peer's API: `/log` with its two §8.2 headers, and `/checkpoints/{height}`
 * with all six components — derived here rather than asserted, so the fixture
 * cannot claim a commitment its own log does not produce.
 */
function peer(options: { lines?: readonly string[]; commitment?: string } = {}): Fetcher {
  const lines = options.lines ?? staged.lines
  const bytes = logFile(lines)
  const hash = digest(logHash(lines))

  // The checkpoint the peer publishes at PEER_HEIGHT, over its own replay.
  const record = checkpointFor(staged.state, PEER_HEIGHT, logHash(staged.lines))

  return (url: string) => {
    if (url.endsWith('/log')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name === 'x-nns-log-hash' ? `0x${hash}` : name === 'x-nns-checkpoint-height' ? String(PEER_HEIGHT) : null,
        },
        arrayBuffer: () =>
          Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer),
        text: () => Promise.resolve(''),
      })
    }
    const body = {
      checkpoint: {
        height: PEER_HEIGHT,
        layout: record.layout,
        nameRoot: `0x${record.name_root.toString('hex')}`,
        pricesRoot: `0x${record.prices_root.toString('hex')}`,
        pendingRoot: `0x${record.pending_root.toString('hex')}`,
        unreservedRoot: `0x${record.unreserved_root.toString('hex')}`,
        logHash: `0x${digest(logHash(lines))}`,
        commitment: options.commitment ?? `0x${record.commitment.toString('hex')}`,
      },
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      text: () => Promise.resolve(JSON.stringify(body)),
    })
  }
}

/** The §8.1 row the peer would have written, derived through the same core call. */
function checkpointFor(state: NnsState, height: number, log: Uint8Array) {
  // `advanceTo` is what puts the staged state at the boundary height; the
  // commitment function takes the height from the state.
  return checkpointRow(coreCheckpoint(advanceTo(state, height), log))
}

const node = () =>
  fakeNode({ head: PEER_HEIGHT + BLOCKS_PER_BATCH * 4, genesis: GENESIS, horizon: GENESIS })

describe.skipIf(URL_ === undefined)('bootstrap', () => {
  const pool = createPool(POOL_URL)
  const { logger } = collectingLogger()

  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`)
    await migrate(pool, logger)
  })
  afterAll(async () => {
    await pool.end()
  })
  // A fresh schema per test rather than a sweep of DELETEs: every case here
  // is about what an *empty* database does, and a leftover row would make one
  // of them pass for the wrong reason.
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`)
    await migrate(pool, logger)
  })

  const run = (fetcher: Fetcher) =>
    bootstrap({
      store: new Store(pool, CONFIG, logger),
      rpc: node().rpc,
      logger,
      config: CONFIG,
      sourceUrl: 'https://peer.example.com',
      launchHeight: LAUNCH_HEIGHT,
      fetcher,
    })

  it('replays a verified log into state, and stops one batch below the peer', async () => {
    const result = await run(peer())
    const store = new Store(pool, CONFIG, logger)

    expect(result.checkpointHeight).toBe(PEER_HEIGHT)
    // The last macro block below the peer's batch: the whole persisted prefix
    // is covered by the commitment checked at PEER_HEIGHT, and the final batch
    // is left for the chain scan.
    expect(result.throughHeight).toBe(PEER_HEIGHT - BLOCKS_PER_BATCH)

    const state = await store.loadState()
    expect(state.height).toBe(result.throughHeight)
    expect([...state.names.keys()].sort()).toEqual(['alicename', 'bobsname'])

    const cursor = await store.loadCursor()
    expect(cursor?.nextBatch).toBe(result.nextBatch)
    expect(cursor?.scannedThrough).toBe(result.throughHeight)
  })

  it('records where the state came from, in the same transaction as the rows', async () => {
    const result = await run(peer())
    const verification = await new Store(pool, CONFIG, logger).loadVerification()
    expect(verification).toMatchObject({
      verifiedFrom: result.verifiedFrom,
      bootstrapHeight: result.throughHeight,
      bootstrapSource: 'https://peer.example.com',
      shadowThrough: null,
    })
    // The first block the scanner will read — above everything the log wrote.
    expect(result.verifiedFrom).toBeGreaterThan(result.throughHeight)
    expect(verification?.bootstrapLogHash).toBe(digest(logHash(staged.lines)))
  })

  it('writes nothing when the replay does not reproduce the peer commitment', async () => {
    await expect(run(peer({ commitment: `0x${'11'.repeat(32)}` }))).rejects.toThrow(BootstrapError)
    // Verified before the first row: a refusal leaves an empty database, not a
    // half-seeded one that a restart would tail from.
    const store = new Store(pool, CONFIG, logger)
    expect(await store.loadCursor()).toBeNull()
    expect(await store.loadVerification()).toBeNull()
    // `db.ts` parses INT8 to `number`, count(*) included.
    expect((await pool.query('SELECT count(*)::int AS n FROM log')).rows[0]).toMatchObject({ n: 0 })
  })

  it('names the component that disagrees, not just that something does', async () => {
    await expect(run(peer({ commitment: `0x${'11'.repeat(32)}` }))).rejects.toThrow(/commitment is/)
  })

  it('refuses a log whose lines do not replay to the verdicts they claim', async () => {
    const tampered = [...staged.lines]
    const first = tampered[0] as string
    tampered[0] = first.replace(/ \S+$/, ' INSUFFICIENT_FEE')
    await expect(run(peer({ lines: tampered }))).rejects.toThrow(/did not reproduce line 0/)
  })

  it('refuses a log that is out of §5.2 order — the hash over it is order-dependent', async () => {
    await expect(run(peer({ lines: [staged.lines[1] as string, staged.lines[0] as string] }))).rejects.toThrow(
      /the log is ordered by §5.2/,
    )
  })
})
