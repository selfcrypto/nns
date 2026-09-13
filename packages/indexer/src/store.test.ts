/**
 * `configFingerprint` is pure and runs unconditionally. Everything below it is
 * Store integration — **needs a real Postgres**, and is skipped without one.
 *
 *   NNS_TEST_DATABASE_URL=postgres://…/nns_test pnpm vitest run --project indexer
 *
 * It creates and drops its own schema, so point it at a throwaway database.
 * Everything here is SQL: the migration, the upsert/delete paths, the
 * per-batch transaction. None of it is exercised by the pure tests, and none
 * of it can be — which is exactly why this file exists rather than a mock.
 *
 * **The schema is named, not `public`.** `packages/api`'s gated suite points
 * at the same `NNS_TEST_DATABASE_URL`, and vitest runs the two projects in
 * parallel — when both claimed `public`, whichever dropped second deleted the
 * other's tables mid-run, and the failures read as "relation does not exist"
 * from code that had just created it. Each suite owning a named schema makes
 * the two independent, so the gate can be satisfied by a plain `pnpm test`
 * rather than one project at a time. The search_path is set on the connection
 * itself, so `migrate()` and every query land in it with no change to
 * `createPool`.
 */

import {
  checkpoint,
  CONSTANTS,
  defineConfig,
  initialState,
  logHash,
  parseAddress,
  type Auction,
  type NameRecord,
  type NnsState,
  type Obligation,
} from '@nimiqnames/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CheckpointBuilder, checkpointRow, COMMITMENT_LAYOUT, hex, logLineFromRow } from './checkpoint.js'
import { createPool, migrate } from './db.js'
import { configFingerprint, Store } from './store.js'
import { nameRows, rowsOf, type LogRow } from './rows.js'
import { collectingLogger } from './test-fixtures.js'

const URL = process.env['NNS_TEST_DATABASE_URL']

/**
 * This suite's own schema. Appended as a libpq `options` parameter rather than
 * issued as a `SET`, so it is in force on every pooled connection from the
 * first one — a `SET` on the pool only reaches the connection that ran it.
 * Built by hand because `URL` above shadows the global `URL` constructor.
 */
const SCHEMA = 'store_test'
const POOL_URL =
  URL === undefined ? '' : `${URL}${URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`

const A = 'NQ28 TKBF VF67 HP8R Y812 5FNM NNDN TS7Q F5G3' // CONSTANTS.TREASURY_ADDRESS, spaced as the RPC prints it
const B = 'NQ38 NKD4 7ALG YRDQ DXL8 PARE 7JRS JGJD MAU8' // CONSTANTS.PROTOCOL_ADDRESS
const C = 'NQ80 6XNV JDFY YEKF HMM3 UCYK VBLP 7H6Y FNXS' // CONSTANTS.ADMIN_ADDRESS
const D = 'NQ71 TPMV QN9D MV6A 1HX1 NL2Q 4CJG 5J8M QPTB' // CONSTANTS.MARKETPLACE_ADDRESS

const CONFIG = defineConfig({ networkId: 24 })

const compact = (value: string) => parseAddress(value)

describe('configFingerprint', () => {
  // `Store.loadCursor` refuses a database whose stored fingerprint differs from
  // the running config, which is what stops an indexer continuing on top of
  // rows a replay from scratch would never have produced. A §3 value that
  // failed to reach the payload would leave that check passing while the two
  // deployments disagreed — visible only much later, as a divergent root.
  //
  // The function is pure, so this belongs above the Postgres gate rather than
  // inside it, where it sat until the test audit on 2026-08-14.

  const fingerprint = (input: Parameters<typeof defineConfig>[0]) => configFingerprint(defineConfig(input))
  const BASELINE = configFingerprint(CONFIG)

  it('is a sha256 digest, and the same config always produces it', () => {
    expect(BASELINE).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprint({ networkId: 24 })).toBe(BASELINE)
  })

  it('changes when networkId changes — the one configurable input left', () => {
    expect(fingerprint({ networkId: 5 })).not.toBe(BASELINE)
  })

  it('covers the frozen §3 constants, pinned as a known answer', () => {
    // Everything except networkId moved into CONSTANTS at the launch freeze
    // and can no longer be varied from a test — so the payload's dependency on
    // the frozen values is pinned as a digest instead. Two edits are expected
    // before launch and must both invalidate every database built earlier:
    // expanding RESERVED_NAMES (free until `LAUNCH_HEIGHT`, §10.6 closes it
    // afterwards) and the second freeze that bumps `LAUNCH_HEIGHT` and
    // replaces the four battery addresses at the launch freeze. This digest
    // moving means "rebuild, do not resume" — recompute it and update the pin
    // alongside either edit.
    expect(BASELINE).toBe('8111f0c068d3fe5f7427b948ae7e89c1c05143ac3a544769d97ad8f9d624897b')
    // Order is not protocol (§4.1 is exact-match membership), which is what the
    // `.sort()` in the payload buys: resorting the constant leaves this digest
    // alone, and only an added, removed or edited entry moves it.
    expect([...CONSTANTS.RESERVED_NAMES].sort()).toEqual([...CONSTANTS.RESERVED_NAMES])
  })
})

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
          evm: '',
          host: 'resolver.example.com',
        },
      ],
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
  const pool = createPool(POOL_URL)
  const { logger } = collectingLogger()
  const store = new Store(pool, CONFIG, logger)

  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`)
    await migrate(pool, logger)
  })
  afterAll(async () => {
    await pool.end()
  })

  it('starts empty', async () => {
    expect(await store.loadCursor()).toBeNull()
    expect((await store.loadState()).height).toBe(CONSTANTS.LAUNCH_HEIGHT)
  })

  it('commits a batch and reloads it exactly', async () => {
    const before = initialState()
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
    const after = populated(initialState())
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
    const before = populated(initialState())
    const after = Object.freeze({ ...before, names: new Map<string, NameRecord>(), height: before.height + 720 })
    await store.commitBatch({ before, after, logRows: [], nextBatch: 912_019, scannedThrough: 58_177_080 })
    expect((await store.loadState()).names.size).toBe(0)
  })

  it('refuses a database built under a different config', async () => {
    const other = new Store(pool, defineConfig({ networkId: 5 }), logger)
    await expect(other.loadCursor()).rejects.toThrow(/different deployment config/)
  })

  it('refuses a database whose checkpoints were written at another §8.1 layout', async () => {
    // The first layout bump since the column was added (2026-09-11, layout
    // 6). `configFingerprint` covers configuration, not rules, so this column
    // is what stands between a layout-5 database and a silently wrong resume.
    // The row is planted as a pre-012 indexer would have left it: a layout the
    // current function does not produce, under the same fingerprint.
    const record = at(58_176_720, initialState())
    const row = { ...checkpointRow(record), layout: COMMITMENT_LAYOUT - 1 }
    await pool.query(
      `INSERT INTO checkpoints (height, layout, name_root, prices_root, pending_root, unreserved_root, log_hash, commitment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [row.height, row.layout, row.name_root, row.prices_root, row.pending_root, row.unreserved_root, row.log_hash, row.commitment],
    )
    try {
      await expect(store.loadCursor()).rejects.toThrow(
        new RegExp(`layout ${COMMITMENT_LAYOUT - 1} \\(latest at height 58176720\\).*derives layout ${COMMITMENT_LAYOUT}.*Rebuild from empty`),
      )
    } finally {
      await pool.query('DELETE FROM checkpoints WHERE height = 58176720')
    }
    expect(await store.loadCursor()).not.toBeNull()
  })

  // ── Checkpoints (§8.1) ────────────────────────────────────────────────────

  const at = (height: number, state: NnsState) =>
    checkpoint(Object.freeze({ ...state, height }), logHash([]))

  it('writes a checkpoint in the batch transaction and reads it back', async () => {
    const state = initialState()
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
    const state = initialState()
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
      ...initialState(),
      names: new Map<string, NameRecord>([
        [
          'divergent',
          {
            name: 'divergent',
            owner: compact(A),
            target: compact(A),
            expiry: 215_880_000,
            status: 'REGISTERED',
            evm: '',
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
      commitment: hex(at(58_177_440, initialState()).commitment),
    })
  })

  // These two write at their own heights, so they follow the row-count and
  // divergence tests above rather than interleaving with them.

  it('stores the unreserved digest, which is what localises a released-name divergence', async () => {
    // The reason the column exists (migration 003). Two states differing only
    // in a fired `U` agree on every other component, so `unreserved_root` is
    // the only per-component column that says *what* they disagree about;
    // without it the difference shows up in `commitment` alone.
    const state = initialState()
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

  it('a fired award differs from a fired release in the tables and the commitment — r22', async () => {
    // The r22 successor to the r17 pending-`U` case. A `U` executes in its
    // landing block, so there is no pending row and no `recipient` column
    // (migration 007) — what separates a release from an award afterwards is
    // that both join `unreserved` while only the award writes a name row.
    //
    // Staged through Postgres because that is where it could go wrong: if the
    // diff wrote the `unreserved` insert and dropped the name row, an award
    // would survive a restart as a release, and an owner would be lost
    // silently — the same failure the r17 case guarded, one revision on.
    const record = {
      name: 'nimiq',
      owner: compact(D),
      target: compact(D),
      expiry: 58_181_040 + CONSTANTS.TERM_LENGTH,
      status: 'REGISTERED' as const,
      evm: '',
      host: '',
    }
    const release = Object.freeze({ ...initialState(), unreserved: new Set(['nimiq']) })
    const award = Object.freeze({ ...release, names: new Map([['nimiq', record]]) })

    // §8.1 separates them, and `name_root` is the component that says how:
    // `unreserved_root` is identical, because tag 0x0A records only that the
    // name left RESERVED_NAMES, not who to.
    const releaseCp = at(58_179_600, release)
    const awardCp = at(58_180_320, award)
    expect(hex(awardCp.unreservedRoot)).toBe(hex(at(58_180_320, release).unreservedRoot))
    expect(hex(awardCp.nameRoot)).not.toBe(hex(at(58_180_320, release).nameRoot))
    expect(hex(awardCp.commitment)).not.toBe(hex(at(58_180_320, release).commitment))

    await store.commitBatch({
      before: initialState(),
      after: Object.freeze({ ...release, height: 58_179_600 }),
      logRows: [],
      checkpoints: [releaseCp],
      nextBatch: 912_040,
      scannedThrough: 58_179_600,
    })
    expect((await store.loadState()).names.get('nimiq')).toBeUndefined()
    expect((await store.loadState()).unreserved.has('nimiq')).toBe(true)

    await store.commitBatch({
      before: Object.freeze({ ...release, height: 58_179_600 }),
      after: Object.freeze({ ...award, height: 58_180_320 }),
      logRows: [],
      checkpoints: [awardCp],
      nextBatch: 912_041,
      scannedThrough: 58_180_320,
    })
    const restored = await store.loadState()
    expect(restored.names.get('nimiq')?.owner).toBe(compact(D))
    expect(restored.unreserved.has('nimiq')).toBe(true)
    expect(await store.checkpointAt(58_180_320)).toMatchObject({
      layout: COMMITMENT_LAYOUT,
      nameRoot: hex(awardCp.nameRoot),
      commitment: hex(awardCp.commitment),
    })
  })

  it('an open auction survives a restart through Postgres, standing bid and ref included — r28', async () => {
    // The round trip is pinned in `rows.test.ts`; this stages it through the
    // table because that is where the r28 columns actually live (migration
    // 010) and where a NUMERIC or BIGINT comes back as a string. The bid's
    // ref is the field a restart can least afford to lose: it is not in the
    // §8.1 entry, and the close owes both legs by it.
    const record = {
      name: 'nimiq',
      owner: compact(D),
      target: compact(D),
      expiry: 58_181_040 + CONSTANTS.TERM_LENGTH,
      status: 'REGISTERED' as const,
      evm: '',
      host: '',
    }
    const noBid: Auction = {
      name: 'nimiq',
      seller: compact(D),
      startingPrice: 50_000_000n,
      endHeight: 58_181_040 + CONSTANTS.AUCTION_MIN_DURATION,
      bidder: null,
      bid: 0n,
      bidRef: null,
    }
    const withBid: Auction = { ...noBid, bidder: compact(C), bid: 52_500_000n, bidRef: { height: 58_181_100, txIndex: 0 } }
    const opened = Object.freeze({
      ...initialState(),
      names: new Map([['nimiq', record]]),
      auctions: new Map([['nimiq', noBid]]),
    })
    const bidOn = Object.freeze({ ...opened, auctions: new Map([['nimiq', withBid]]) })

    await store.commitBatch({
      before: initialState(),
      after: Object.freeze({ ...opened, height: 58_181_040 }),
      logRows: [],
      checkpoints: [],
      nextBatch: 912_042,
      scannedThrough: 58_181_040,
    })
    expect((await store.loadState()).auctions.get('nimiq')).toMatchObject({ bidder: null, bid: 0n, bidRef: null })

    await store.commitBatch({
      before: Object.freeze({ ...opened, height: 58_181_040 }),
      after: Object.freeze({ ...bidOn, height: 58_181_100 }),
      logRows: [],
      checkpoints: [],
      nextBatch: 912_043,
      scannedThrough: 58_181_100,
    })
    const restored = await store.loadState()
    expect(restored.auctions.get('nimiq')).toEqual(withBid)

    // The table refuses a half-present bid, not just the mapping.
    await expect(
      pool.query(
        `INSERT INTO pending (kind, name, seller, starting_price, end_height, bid, bid_ref_height)
         VALUES ('AUCTION', 'wallet', $1, 50000000, 58267440, 0, 58181100)`,
        [compact(D)],
      ),
    ).rejects.toThrow(/pending_auction_shape/)
  })

  it('accepts no UNRESERVE pending row — migration 007 dropped the kind (r22)', async () => {
    // The schema is where this is pinned, not the mapping: `pendingRows` can
    // no longer produce the shape, so a row could only arrive from a pre-r22
    // writer, and that is exactly the case that must fail rather than resume.
    await expect(
      pool.query(
        `INSERT INTO pending (kind, name, effective_height) VALUES ('UNRESERVE', 'nimiq', 58181040)`,
      ),
    ).rejects.toThrow(/pending_kind_check/)
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

  it('replaces the proof snapshot wholesale with the checkpoint it belongs to (migration 005)', async () => {
    const snapshotRows = async () =>
      (await pool.query<{ height: number; name: string }>(
        'SELECT height, name FROM checkpoint_names ORDER BY name',
      )).rows

    const first = populated(initialState())
    await store.commitBatch({
      before: initialState(),
      after: first,
      logRows: [],
      snapshot: { height: 58_181_760, names: nameRows(first) },
      nextBatch: 912_040,
      scannedThrough: 58_181_760,
    })
    expect(await snapshotRows()).toEqual([{ height: 58_181_760, name: 'alice-example' }])

    // The next checkpoint's snapshot replaces, never accumulates: the table
    // is one checkpoint's name records, and a leftover row from the previous
    // boundary would change the derived root — which the API checks, so the
    // failure would be "no proofs", silently, until someone asked why.
    const second = Object.freeze({
      ...first,
      names: new Map([['zeta-name', { ...(first.names.get('alice-example') as NameRecord), name: 'zeta-name' }]]),
      height: first.height + 720,
    })
    await store.commitBatch({
      before: first,
      after: second,
      logRows: [],
      snapshot: { height: 58_182_480, names: nameRows(second) },
      nextBatch: 912_041,
      scannedThrough: 58_182_480,
    })
    expect(await snapshotRows()).toEqual([{ height: 58_182_480, name: 'zeta-name' }])
  })
})
