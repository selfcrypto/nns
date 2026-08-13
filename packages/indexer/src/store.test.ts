/**
 * Store integration — **needs a real Postgres**, and is skipped without one.
 *
 *   NNS_TEST_DATABASE_URL=postgres://…/nns_test pnpm vitest run --project indexer
 *
 * It creates and drops its own schema, so point it at a throwaway database.
 * Everything here is SQL: the migration, the upsert/delete paths, the
 * per-batch transaction. None of it is exercised by the pure tests, and none
 * of it can be — which is exactly why this file exists rather than a mock.
 */

import {
  checkpoint,
  defineConfig,
  initialState,
  logHash,
  parseAddress,
  type NameRecord,
  type NnsState,
  type Obligation,
  type PendingRecovery,
} from '@nns/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CheckpointBuilder, COMMITMENT_LAYOUT, hex, logLineFromRow } from './checkpoint.js'
import { createPool, migrate } from './db.js'
import { Store } from './store.js'
import { rowsOf, type LogRow } from './rows.js'
import { collectingLogger } from './test-fixtures.js'

const URL = process.env['NNS_TEST_DATABASE_URL']
const A = 'NQ34 248H 248H 248H 248H 248H 248H 248H 248H'
const B = 'NQ93 48H2 48H2 48H2 48H2 48H2 48H2 48H2 48H2'
const C = 'NQ60 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK'
const D = 'NQ14 8H24 8H24 8H24 8H24 8H24 8H24 8H24 8H24'

const CONFIG = defineConfig({
  networkId: 24,
  launchHeight: 58_177_000,
  treasury: A,
  protocol: B,
  admin: C,
  marketplace: D,
  listingFee: 0n,
})

const compact = (value: string) => parseAddress(value)

function populated(base: NnsState): NnsState {
  return Object.freeze({
    ...base,
    height: base.height + 720,
    names: new Map<string, NameRecord>([
      [
        'alice-example',
        {
          name: 'alice-example',
          owner: compact(A),
          target: compact(B),
          expiry: 215_880_000,
          status: 'REGISTERED',
          recovery: compact(C),
          host: 'resolver.example.com',
        },
      ],
    ]),
    recoveries: new Map<string, PendingRecovery>([
      ['alice-example', { name: 'alice-example', recovery: null, effectiveHeight: 58_250_000 }],
    ]),
    outstanding: new Map<string, Obligation[]>([
      [
        '58190001:3',
        [
          { ref: { height: 58_190_001, txIndex: 3 }, kind: 'SALE_PROCEEDS', owedBy: compact(D), owedTo: compact(A), amount: 390_000_000_000n },
          { ref: { height: 58_190_001, txIndex: 3 }, kind: 'COMMISSION', owedBy: compact(D), owedTo: compact(B), amount: 10_000_000_000n },
        ],
      ],
    ]),
    nextDueHeight: 58_250_000,
  })
}

describe.skipIf(URL === undefined)('Store', () => {
  const pool = createPool(URL ?? '')
  const { logger } = collectingLogger()
  const store = new Store(pool, CONFIG, logger)

  beforeAll(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await migrate(pool, logger)
  })
  afterAll(async () => {
    await pool.end()
  })

  it('starts empty', async () => {
    expect(await store.loadCursor()).toBeNull()
    expect((await store.loadState()).height).toBe(CONFIG.launchHeight)
  })

  it('commits a batch and reloads it exactly', async () => {
    const before = initialState(CONFIG)
    const after = populated(before)
    await store.commitBatch({
      before: null,
      after,
      logRows: [
        {
          block_height: 58_177_017,
          tx_index: 0,
          tx_hash: 'ab'.repeat(32),
          sender: compact(A),
          recipient: compact(B),
          value: '400000000',
          data: '4e4e533147746573746e616d65',
          verdict: 'OK',
        },
      ],
      nextBatch: 912_018,
      scannedThrough: 58_177_020,
    })

    const reloaded = await store.loadState()
    expect(rowsOf(reloaded)).toEqual(rowsOf(after))
    expect(await store.loadCursor()).toMatchObject({ nextBatch: 912_018, scannedThrough: 58_177_020 })
  })

  it('is idempotent on a re-applied batch', async () => {
    // A crash between commit and cursor advance would replay the batch. The
    // log's primary key and the upserts make that harmless.
    const after = populated(initialState(CONFIG))
    await store.commitBatch({
      before: after,
      after,
      logRows: [
        {
          block_height: 58_177_017,
          tx_index: 0,
          tx_hash: 'ab'.repeat(32),
          sender: compact(A),
          recipient: compact(B),
          value: '400000000',
          data: '4e4e533147746573746e616d65',
          verdict: 'OK',
        },
      ],
      nextBatch: 912_018,
      scannedThrough: 58_177_020,
    })
    const count = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM log')
    expect(count.rows[0]?.count).toBe('1')
  })

  it('deletes rows that left the state', async () => {
    const before = populated(initialState(CONFIG))
    const after = Object.freeze({ ...before, names: new Map<string, NameRecord>(), height: before.height + 720 })
    await store.commitBatch({ before, after, logRows: [], nextBatch: 912_019, scannedThrough: 58_177_080 })
    expect((await store.loadState()).names.size).toBe(0)
  })

  it('refuses a database built under a different config', async () => {
    const other = new Store(pool, { ...CONFIG, launchHeight: CONFIG.launchHeight + 1 }, logger)
    await expect(other.loadCursor()).rejects.toThrow(/different deployment config/)
  })

  // ── Checkpoints (§8.1) ────────────────────────────────────────────────────

  const at = (height: number, state: NnsState) =>
    checkpoint(Object.freeze({ ...state, height }), logHash([]))

  it('writes a checkpoint in the batch transaction and reads it back', async () => {
    const state = initialState(CONFIG)
    const record = at(58_177_440, state)
    await store.commitBatch({
      before: state,
      after: Object.freeze({ ...state, height: 58_177_440 }),
      logRows: [],
      checkpoints: [record],
      nextBatch: 912_020,
      scannedThrough: 58_177_440,
    })

    const stored = await store.checkpointAt(58_177_440)
    expect(stored).toEqual({
      height: 58_177_440,
      layout: COMMITMENT_LAYOUT,
      nameRoot: hex(record.nameRoot),
      pricesRoot: hex(record.pricesRoot),
      pendingRoot: hex(record.pendingRoot),
      unreservedRoot: hex(record.unreservedRoot),
      logHash: hex(record.logHash),
      commitment: hex(record.commitment),
    })
    expect(await store.latestCheckpoint()).toMatchObject({ height: 58_177_440 })
  })

  it('accepts the identical checkpoint again — a replayed batch is not a divergence', async () => {
    const state = initialState(CONFIG)
    await store.commitBatch({
      before: state,
      after: Object.freeze({ ...state, height: 58_177_440 }),
      logRows: [],
      checkpoints: [at(58_177_440, state)],
      nextBatch: 912_020,
      scannedThrough: 58_177_440,
    })
    const count = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM checkpoints')
    expect(count.rows[0]?.count).toBe('1')
  })

  it('refuses to overwrite a checkpoint that disagrees', async () => {
    // The one failure mode the whole design exists to catch. A silent
    // DO NOTHING here would keep the first root while the indexer carried on
    // producing the second.
    const different = Object.freeze({
      ...initialState(CONFIG),
      names: new Map<string, NameRecord>([
        [
          'divergent',
          {
            name: 'divergent',
            owner: compact(A),
            target: compact(A),
            expiry: 215_880_000,
            status: 'REGISTERED',
            recovery: null,
            host: '',
          },
        ],
      ]),
    })
    await expect(
      store.commitBatch({
        before: different,
        after: Object.freeze({ ...different, height: 58_177_440 }),
        logRows: [],
        checkpoints: [at(58_177_440, different)],
        nextBatch: 912_020,
        scannedThrough: 58_177_440,
      }),
    ).rejects.toThrow(/checkpoint divergence at height 58177440/)

    // …and the transaction rolled back, so the stored root is untouched.
    expect(await store.checkpointAt(58_177_440)).toMatchObject({
      commitment: hex(at(58_177_440, initialState(CONFIG)).commitment),
    })
  })

  // These two write at their own heights, so they follow the row-count and
  // divergence tests above rather than interleaving with them.

  it('stores the unreserved digest, which is what localises a released-name divergence', async () => {
    // The reason the column exists (migration 003). Two states differing only
    // in a fired `U` agree on every other component, so `unreserved_root` is
    // the only per-component column that says *what* they disagree about;
    // without it the difference shows up in `commitment` alone.
    const state = initialState(CONFIG)
    const released = Object.freeze({ ...state, unreserved: new Set(['nimiq']) })
    const plain = at(58_178_160, state)
    const withU = at(58_178_160, released)

    expect(hex(withU.unreservedRoot)).not.toBe(hex(plain.unreservedRoot))
    for (const component of ['nameRoot', 'pricesRoot', 'pendingRoot', 'logHash'] as const) {
      expect(hex(withU[component])).toBe(hex(plain[component]))
    }
    expect(hex(withU.commitment)).not.toBe(hex(plain.commitment))

    await store.commitBatch({
      before: state,
      after: Object.freeze({ ...released, height: 58_178_160 }),
      logRows: [],
      checkpoints: [withU],
      nextBatch: 912_030,
      scannedThrough: 58_178_160,
    })
    expect(await store.checkpointAt(58_178_160)).toMatchObject({
      layout: COMMITMENT_LAYOUT,
      unreservedRoot: hex(withU.unreservedRoot),
    })
  })

  it('rejects a row whose unreserved digest disagrees with its layout', async () => {
    // Migration 003's CHECK, in both directions: a layout 1 row carries no such
    // digest because the function that produced it had none, and no layout at
    // or above 2 may omit one. Written straight to SQL — `checkpointRow` cannot
    // produce either shape, which is why the schema is where this is pinned.
    const bytes = Buffer.alloc(32, 7)
    const insert = (height: number, layout: number, unreservedRoot: Buffer | null) =>
      pool.query(
        `INSERT INTO checkpoints
           (height, layout, name_root, prices_root, pending_root, unreserved_root, log_hash, commitment)
         VALUES ($1, $2, $3, $3, $3, $4, $3, $3)`,
        [height, layout, bytes, unreservedRoot],
      )
    await expect(insert(58_178_880, 1, bytes)).rejects.toThrow(/checkpoints_unreserved_root_matches_layout/)
    await expect(insert(58_178_880, 2, null)).rejects.toThrow(/checkpoints_unreserved_root_matches_layout/)

    // The r15 shape the column was made nullable for, and it reads back as null.
    await insert(58_178_880, 1, null)
    expect(await store.checkpointAt(58_178_880)).toMatchObject({ layout: 1, unreservedRoot: null })
  })

  it('streams the log back in canonical order, and reproduces the log hash', async () => {
    // The restart path: the running §8.2 hash is rebuilt from this table.
    // chunkSize 1 forces the keyset pagination to page.
    const rows: LogRow[] = []
    const streamed = await store.streamLogRows((row) => rows.push(row), 1)
    expect(streamed).toBe(rows.length)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.map((row) => [row.block_height, row.tx_index])).toEqual(
      [...rows].sort((a, b) => a.block_height - b.block_height || a.tx_index - b.tx_index)
        .map((row) => [row.block_height, row.tx_index]),
    )

    const builder = new CheckpointBuilder({ logger })
    for (const row of rows) builder.seed(row)
    expect(builder.lines).toBe(rows.length)
    expect(hex(builder.logHash)).toBe(hex(logHash(rows.map(logLineFromRow))))
  })
})
