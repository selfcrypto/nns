/**
 * Rules rebuild round trip — **needs a real Postgres**, and is skipped without
 * one.
 *
 *   NNS_TEST_DATABASE_URL=postgres://…/nns_test pnpm vitest run --project indexer
 *
 * What this has to establish is a byte claim about tables, so it seeds through
 * the production path — a `Scanner` over a fake chain, `Pipeline`,
 * `CheckpointBuilder`, `Store.commitBatch`, exactly as `main.ts` wires them —
 * and then rebuilds that database from its own log. Under the same rules the
 * rebuild must be a **no-op on every derived byte**, which is the strongest
 * form of "byte-identical to a scratch rebuild" this can state without
 * replaying a chain.
 *
 * Own schema, for the reason `store.test.ts` explains at length.
 */

import {
  CONSTANTS,
  encodeRegister,
  encodeTransfer,
  feeFor,
  initialState,
  type NnsState,
} from '@nimiqnames/core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { BLOCKS_PER_BATCH, geometryFor } from './chain.js'
import { CheckpointBuilder } from './checkpoint.js'
import { createPool, migrate } from './db.js'
import { Pipeline } from './pipeline.js'
import { RebuildError, geometryFromCursor, rebuildFromLog } from './rebuild.js'
import { nameRows } from './rows.js'
import { Scanner } from './scan.js'
import { Store, StoreError, type Cursor } from './store.js'
import {
  BUYER,
  LAUNCH_HEIGHT,
  MAINNET,
  SELLER,
  chainBlocks,
  collectingLogger,
  fakeNode,
  send,
  testConfig,
} from './test-fixtures.js'

const URL_ = process.env['NNS_TEST_DATABASE_URL']
const SCHEMA = 'rebuild_test'
const POOL_URL =
  URL_ === undefined
    ? ''
    : `${URL_}${URL_.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`

const CONFIG = testConfig()
const REVISION = CONSTANTS.SPEC_REVISION

// LAUNCH_HEIGHT sits on a batch boundary, so the launch batch is 1 and every
// number below reads as itself.
const GENESIS = LAUNCH_HEIGHT - BLOCKS_PER_BATCH
const GEOMETRY = geometryFor(GENESIS)
/** Enough batches to cross several §8.1 boundaries and leave a tail. */
const LAST_BATCH = 40
const HEAD = GEOMETRY.macroBlockOf(LAST_BATCH + 2)

const PRICES = initialState().prices
const SENDS = [
  send(LAUNCH_HEIGHT + 5, 0, SELLER, encodeRegister({ name: 'alicename', fee: feeFor('alicename', PRICES) })),
  send(LAUNCH_HEIGHT + 65, 0, SELLER, encodeRegister({ name: 'bobsname', fee: feeFor('bobsname', PRICES) })),
  send(LAUNCH_HEIGHT + 125, 0, SELLER, encodeTransfer({ name: 'alicename', newOwner: BUYER })),
]

/**
 * Every derived table, as one comparable dump.
 *
 * `created_at` / `updated_at` are dropped: they record when a row was written,
 * which a rebuild is entitled to move and which says nothing about what the
 * rules derived. Every other column is compared, `BYTEA` roots included.
 */
async function derived(pool: ReturnType<typeof createPool>): Promise<Record<string, unknown[]>> {
  const dump: Record<string, unknown[]> = {}
  for (const [table, order] of [
    ['names', 'name'],
    ['pending', 'kind, name'],
    ['unreserved', 'name'],
    ['settlements', 'ref_height, ref_tx_index, ordinal'],
    ['params', 'id'],
    ['checkpoints', 'height'],
    ['checkpoint_names', 'name'],
    ['log', 'block_height, tx_index'],
    ['cursor', 'id'],
  ] as const) {
    const result = await pool.query(`SELECT * FROM ${table} ORDER BY ${order}`)
    dump[table] = result.rows.map((row) =>
      Object.fromEntries(Object.entries(row as object).filter(([column]) => !column.endsWith('_at'))),
    )
  }
  return dump
}

describe.skipIf(URL_ === undefined)('rebuildFromLog', () => {
  const pool = createPool(POOL_URL)
  const { logger } = collectingLogger()
  const store = new Store(pool, CONFIG, logger)

  /** Seed the database the way the indexer would: scan a fake chain into it. */
  async function seed(): Promise<NnsState> {
    const node = fakeNode({
      head: HEAD,
      genesis: GENESIS,
      horizon: GENESIS,
      blocks: chainBlocks(SENDS, CONFIG),
    })
    const pipeline = new Pipeline(CONFIG, logger)
    const checkpoints = new CheckpointBuilder({ logger })
    let state = initialState()
    const scanner = new Scanner({
      rpc: node.rpc,
      logger,
      networkId: MAINNET,
      launchHeight: LAUNCH_HEIGHT,
      pollIntervalMs: 1,
      stopAfterBatch: LAST_BATCH,
      onBatchComplete: async ({ batch, macroBlock, candidates }) => {
        const before = state
        const result = pipeline.applyBatch(before, candidates, macroBlock)
        const due = checkpoints.buildForBatch(result)
        const boundary = result.boundariesCrossed[result.boundariesCrossed.length - 1]
        await store.commitBatch({
          before,
          after: result.state,
          logRows: result.logRows,
          checkpoints: due,
          ...(boundary === undefined
            ? {}
            : { snapshot: { height: boundary.height, names: nameRows(boundary.state) } }),
          nextBatch: batch + 1,
          scannedThrough: macroBlock,
        })
        state = result.state
      },
      sleep: async () => {},
    })
    await scanner.run(new AbortController().signal)
    return state
  }

  const rebuild = (revision: number = REVISION) =>
    rebuildFromLog({ store, logger, config: CONFIG, launchHeight: LAUNCH_HEIGHT, revision })

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
  })

  it('under the same rules, changes no derived byte', async () => {
    const state = await seed()
    const before = await derived(pool)

    const result = await rebuild()

    expect(result.lines).toBe(3)
    expect(result.verdictsRewritten).toBe(0)
    expect(result.names).toBe(state.names.size)
    expect(result.through).toBe(GEOMETRY.macroBlockOf(LAST_BATCH))
    expect(result.nextBatch).toBe(LAST_BATCH + 1)

    const after = await derived(pool)
    // Every table, including `log` and `cursor` — the rebuild rewrites the
    // first only where a verdict moved and never touches the second.
    expect(after).toEqual(before)
  })

  it('moves a verdict that the rules now decide differently', async () => {
    await seed()
    // What a rules change looks like from inside the log: a token the current
    // reducer no longer agrees with. Everything else about the line stands.
    const target = LAUNCH_HEIGHT + 65
    await pool.query('UPDATE log SET verdict = $1 WHERE block_height = $2', ['FORFEIT:UNKNOWN_TYPE', target])

    const result = await rebuild()

    expect(result.verdictsRewritten).toBe(1)
    const row = await pool.query<{ verdict: string }>('SELECT verdict FROM log WHERE block_height = $1', [
      target,
    ])
    expect(row.rows[0]?.verdict).toBe('OK')
  })

  it('refuses when a stored line is not reproduced, and writes nothing', async () => {
    await seed()
    const before = await derived(pool)
    // A line the current §7.5 discards: no payload prefix, so the reducer
    // returns IGNORED and §7.6 gives it no line. That is exactly the shape of
    // a revision that logs fewer messages than the one that wrote this log.
    await pool.query(
      `INSERT INTO log (block_height, tx_index, tx_hash, sender, recipient, value, data, verdict)
       VALUES ($1, 7, 'ff', $2, $3, 1, '00', 'OK')`,
      [LAUNCH_HEIGHT + 66, CONSTANTS.TREASURY_ADDRESS, CONSTANTS.TREASURY_ADDRESS],
    )

    await expect(rebuild()).rejects.toThrow(StoreError)
    await expect(rebuild()).rejects.toThrow(/did not reproduce the log line/)

    const after = await derived(pool)
    // The whole rebuild is one transaction, so a refusal leaves the registry
    // exactly as it was — including the row that caused it.
    expect(after['names']).toEqual(before['names'])
    expect(after['checkpoints']).toEqual(before['checkpoints'])
    expect(after['params']).toEqual(before['params'])
  })

  it('refuses when a stored field would move, not just its verdict', async () => {
    await seed()
    // A log written with a different canonical form for the payload — §8.2
    // says lowercase hex, and this line is uppercase. The replay re-derives
    // the line through `canonicalLogLine`, so the stored field and the
    // produced one disagree, and the log cannot say which of the two the
    // transaction actually carried. That needs the chain.
    //
    // The addresses cannot be tested the same way and do not need to be:
    // `sender` and `recipient` are `CHAR(36)`, so a non-compact one does not
    // fit the column at all.
    await pool.query('UPDATE log SET data = upper(data) WHERE block_height = $1', [LAUNCH_HEIGHT + 5])
    await expect(rebuild()).rejects.toThrow(/rewrote a stored field/)
  })

  it('records the rebuild with the rows, and schedules the sweep', async () => {
    await seed()
    await rebuild()

    const verification = await store.loadVerification()
    expect(verification).toMatchObject({
      verifiedFrom: LAUNCH_HEIGHT,
      bootstrapHeight: null,
      rebuiltRevision: REVISION,
      rebuiltThrough: GEOMETRY.macroBlockOf(LAST_BATCH),
    })
    const at = await pool.query<{ rebuilt_at: Date | null }>('SELECT rebuilt_at FROM verification WHERE id')
    expect(at.rows[0]?.rebuilt_at).toBeInstanceOf(Date)

    // And the sweep clears it: the range has been re-derived from the chain,
    // so the declaration is no longer outstanding.
    await store.completeVerification(LAUNCH_HEIGHT)
    expect(await store.loadVerification()).toMatchObject({
      rebuiltRevision: null,
      rebuiltThrough: null,
    })
  })

  it('rebuilds a database whose checkpoints are at an older §8.1 layout', async () => {
    // The refusal migration 012 added is what a layout bump leaves behind, and
    // this verb is the documented way out of it: `loadCursor` still refuses,
    // the rebuild proceeds and replaces every row it was refusing over.
    await seed()
    await pool.query('UPDATE checkpoints SET layout = layout - 1')

    await expect(store.loadCursor()).rejects.toThrow(/layout/)
    await expect(rebuild()).resolves.toMatchObject({ lines: 3 })

    const layouts = await pool.query<{ layout: number }>('SELECT DISTINCT layout FROM checkpoints')
    expect(layouts.rows).toEqual([{ layout: (await import('./checkpoint.js')).COMMITMENT_LAYOUT }])
  })

  it('refuses a declaration that is not this build, before reading a row', async () => {
    await seed()
    await expect(rebuild(REVISION - 1)).rejects.toThrow(RebuildError)
    await expect(rebuild(REVISION - 1)).rejects.toThrow(/this build implements/)
  })

  it('refuses a database that has never scanned a batch', async () => {
    await expect(rebuild()).rejects.toThrow(/no cursor/)
  })
})

describe('geometryFromCursor', () => {
  it('derives the PoS genesis the node measured, from two stored numbers', () => {
    // `scanned_through` is the macro block closing `next_batch - 1`, which is
    // the whole derivation — no RPC, no binary search, no guess.
    const cursor: Cursor = {
      nextBatch: 920_861,
      scannedThrough: 3_456_000 + 920_860 * BLOCKS_PER_BATCH,
      configFingerprint: 'x',
    }
    const geometry = geometryFromCursor(cursor)
    expect(geometry.genesisBlock).toBe(3_456_000)
    // The mainnet pair from docs/rpc-reference.md: head 58,707,553 is batch
    // 920,860, spanning 58,707,541–58,707,600.
    expect(geometry.firstBlockOf(920_860)).toBe(58_707_541)
    expect(geometry.macroBlockOf(920_860)).toBe(58_707_600)
  })

  it('refuses a pair that puts the genesis below zero', () => {
    expect(() =>
      geometryFromCursor({ nextBatch: 900_000, scannedThrough: 10, configFingerprint: 'x' }),
    ).toThrow(RebuildError)
  })
})
