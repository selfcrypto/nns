/**
 * `hybrid`'s background re-derivation — **needs a real Postgres**, and is
 * skipped without one.
 *
 *   NNS_TEST_DATABASE_URL=postgres://…/nns_test pnpm vitest run --project indexer
 *
 * What the sweep is *for* is catching a log that is internally perfect and
 * still wrong, so the interesting fixture is a chain the bootstrapped log does
 * not account for. That needs both halves — a §8.2 log and a chain that agree
 * except where the test makes them differ — which `stageLog` and `chainBlocks`
 * build from one list of sends.
 */

import {
  advanceTo,
  checkpoint as coreCheckpoint,
  CONSTANTS,
  encodeRegister,
  feeFor,
  initialState,
  logHash,
} from '@nns/core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { bootstrap } from './bootstrap.js'
import { BLOCKS_PER_BATCH } from './chain.js'
import { checkpointRow, hex } from './checkpoint.js'
import { createPool, migrate } from './db.js'
import { verifyFromChain, VerificationError } from './shadow.js'
import type { LogSource, PeerCheckpoint } from './peer.js'
import { Store } from './store.js'
import {
  chainBlocks,
  collectingLogger,
  fakeNode,
  LAUNCH_HEIGHT,
  SELLER,
  send,
  stageLog,
  testConfig,
} from './test-fixtures.js'

const URL_ = process.env['NNS_TEST_DATABASE_URL']
const SCHEMA = 'shadow_test'
const POOL_URL =
  URL_ === undefined
    ? ''
    : `${URL_}${URL_.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`

const CONFIG = testConfig()
const INTERVAL = CONSTANTS.CHECKPOINT_INTERVAL
const GENESIS = LAUNCH_HEIGHT - BLOCKS_PER_BATCH
const PEER_HEIGHT = (Math.floor(LAUNCH_HEIGHT / INTERVAL) + 4) * INTERVAL
const THROUGH = PEER_HEIGHT - BLOCKS_PER_BATCH

const prices = initialState().prices
const SENDS = [
  send(LAUNCH_HEIGHT + 5, 0, SELLER, encodeRegister({ name: 'alicename', fee: feeFor('alicename', prices) })),
  send(LAUNCH_HEIGHT + 65, 0, SELLER, encodeRegister({ name: 'bobsname', fee: feeFor('bobsname', prices) })),
]
const staged = stageLog(SENDS, CONFIG)

/** The peer's log, with the §8.1 components derived from those same lines. */
const peerLog = (): LogSource => {
  const row = checkpointRow(coreCheckpoint(advanceTo(staged.state, PEER_HEIGHT), logHash(staged.lines)))
  const components: PeerCheckpoint = {
    height: PEER_HEIGHT,
    layout: row.layout,
    nameRoot: row.name_root.toString('hex'),
    pricesRoot: row.prices_root.toString('hex'),
    pendingRoot: row.pending_root.toString('hex'),
    unreservedRoot: row.unreserved_root.toString('hex'),
    logHash: hex(logHash(staged.lines)),
    commitment: row.commitment.toString('hex'),
  }
  return {
    lines: staged.lines,
    height: PEER_HEIGHT,
    commitment: components.commitment,
    components,
    origin: 'https://peer.example.com',
    evidence: 'peer-checkpoint',
  }
}

const chain = (sends: readonly (typeof SENDS)[number][]) =>
  fakeNode({
    head: PEER_HEIGHT + BLOCKS_PER_BATCH * 4,
    genesis: GENESIS,
    horizon: GENESIS,
    blocks: chainBlocks(sends, CONFIG),
  })

describe.skipIf(URL_ === undefined)('verifyFromChain', () => {
  const pool = createPool(POOL_URL)
  const { logger } = collectingLogger()

  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`)
    await migrate(pool, logger)
  })
  afterAll(async () => {
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`)
    await migrate(pool, logger)
    await bootstrap({
      store: new Store(pool, CONFIG, logger),
      rpc: chain(SENDS).rpc,
      logger,
      config: CONFIG,
      launchHeight: LAUNCH_HEIGHT,
      source: peerLog(),
    })
  })

  const sweep = (sends: readonly (typeof SENDS)[number][]) =>
    verifyFromChain(
      {
        rpc: chain(sends).rpc,
        store: new Store(pool, CONFIG, logger),
        logger,
        config: CONFIG,
        networkId: CONFIG.networkId,
        launchHeight: LAUNCH_HEIGHT,
        pollIntervalMs: 1,
        throughHeight: THROUGH,
      },
      new AbortController().signal,
    )

  it('drops verifiedFrom to LAUNCH_HEIGHT once the chain reproduces every commitment', async () => {
    const store = new Store(pool, CONFIG, logger)
    const before = await store.loadVerification()
    expect(before?.verifiedFrom).toBeGreaterThan(LAUNCH_HEIGHT)

    await sweep(SENDS)

    const after = await store.loadVerification()
    expect(after?.verifiedFrom).toBe(LAUNCH_HEIGHT)
    // The bootstrap is kept on the record, not tidied away: how this database
    // was built stays true after it has been checked.
    expect(after?.bootstrapHeight).toBe(THROUGH)
    expect(after?.bootstrapSource).toBe('https://peer.example.com')
  })

  it('catches a message the log omitted — the one lie a Tier 1 check cannot see', async () => {
    // The log and the peer's commitment agree with each other perfectly; they
    // just do not account for everything that was on chain. This is the whole
    // reason `hybrid` exists.
    const chainHasMore = [
      ...SENDS,
      send(LAUNCH_HEIGHT + 125, 0, SELLER, encodeRegister({ name: 'carolname', fee: feeFor('carolname', prices) })),
    ]
    await expect(sweep(chainHasMore)).rejects.toThrow(VerificationError)
    await expect(sweep(chainHasMore)).rejects.toThrow(/the chain does not agree with the log/)
  })

  it('leaves verifiedFrom alone when it disagrees — a caught divergence is not a downgrade', async () => {
    const chainHasMore = [
      ...SENDS,
      send(LAUNCH_HEIGHT + 125, 0, SELLER, encodeRegister({ name: 'carolname', fee: feeFor('carolname', prices) })),
    ]
    await expect(sweep(chainHasMore)).rejects.toThrow(VerificationError)
    const after = await new Store(pool, CONFIG, logger).loadVerification()
    expect(after?.verifiedFrom).toBeGreaterThan(LAUNCH_HEIGHT)
  })
})
