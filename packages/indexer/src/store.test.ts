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
  defineConfig,
  initialState,
  parseAddress,
  type NameRecord,
  type NnsState,
  type Obligation,
  type PendingRecovery,
} from '@nns/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPool, migrate } from './db.js'
import { Store } from './store.js'
import { rowsOf } from './rows.js'
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
})
