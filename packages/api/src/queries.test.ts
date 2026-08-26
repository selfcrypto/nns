/**
 * PgQueries integration — **needs a real Postgres**, and is skipped without one.
 *
 *   NNS_TEST_DATABASE_URL=postgres://…/nns_test pnpm vitest run --project api
 *
 * It drops and recreates its own schema, so point it at a throwaway
 * database. The schema comes from the indexer's own migrations — the API has
 * none of its own, which is the point: these tests read exactly the tables
 * the indexer writes, in the shape migration `004` leaves them.
 *
 * **The schema is named, not `public`.** `packages/indexer`'s gated suite
 * points at the same `NNS_TEST_DATABASE_URL`, and vitest runs the two
 * projects in parallel — when both claimed `public`, whichever dropped second
 * deleted the other's tables mid-run. See the note in
 * `packages/indexer/src/store.test.ts`.
 */

import {
  BURN_ADDRESS,
  CONSTANTS,
  leafHash,
  logFile,
  logHash,
  merkleRoot,
  parseAddress,
  verifyProof,
  type NameRecord,
  type NameStatus,
  type ProofStep,
} from '@nns/core'
import { createPool, logLineFromRow, migrate, type LogRow } from '@nns/indexer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { NotSyncedError, PgQueries, type ApiNameRecord } from './queries.js'
import { createRoutes } from './routes.js'

const URL = process.env['NNS_TEST_DATABASE_URL']

/**
 * This suite's own schema — see the header. Appended as a libpq `options`
 * parameter so it is in force on every pooled connection, and built by hand
 * because `URL` above shadows the global `URL` constructor. Both describes
 * below share it: the second reads what the first migrated.
 */
const SCHEMA = 'api_test'
const POOL_URL =
  URL === undefined ? '' : `${URL}${URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`

const A = parseAddress('NQ34 248H 248H 248H 248H 248H 248H 248H 248H')
const B = parseAddress('NQ93 48H2 48H2 48H2 48H2 48H2 48H2 48H2 48H2')
const C = parseAddress('NQ60 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK')

const HEIGHT = 58_200_000

describe.skipIf(URL === undefined)('PgQueries', () => {
  const pool = createPool(POOL_URL)
  const queries = new PgQueries(pool)

  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`)
  })
  afterAll(async () => {
    await pool.end()
  })

  it('reports NOT_SYNCED while the schema does not exist', async () => {
    await expect(queries.params()).rejects.toBeInstanceOf(NotSyncedError)
  })

  it('reports NOT_SYNCED after migration but before the first commit', async () => {
    await migrate(pool)
    await expect(queries.record('alice-example')).rejects.toBeInstanceOf(NotSyncedError)
  })

  it('reads back what the indexer writes', async () => {
    await pool.query(
      `INSERT INTO params (fee_standard, fee_long, commission_bp, last_governance_height, state_height, next_due_height)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['400000000', '40000000', '250', 58_150_000, HEIGHT, null],
    )
    await pool.query(
      `INSERT INTO names (name, owner, target, expiry, status, host)
       VALUES ('alice-example', $1, $2, 215880000, 'REGISTERED', 'r.example.com'),
              ('bob-example', $1, $1, 58190000, 'GRACE', '')`,
      [A, B],
    )
    await pool.query(
      `INSERT INTO pending (kind, name, seller, price, opened_height, expiry_height)
       VALUES ('OFFER', 'alice-example', $1, '50000000', 58190000, 59486000)`,
      [A],
    )
    await pool.query(
      `INSERT INTO pending (kind, name, effective_height, fee_standard, fee_long, commission_bp)
       VALUES ('GOVERNANCE', '', 58243200, '800000000', '80000000', '300')`,
    )
    await pool.query(`INSERT INTO unreserved (name) VALUES ('legacy-brand')`)

    const record = await queries.record('alice-example')
    expect(record.height).toBe(HEIGHT)
    expect(record.value).toEqual({
      name: 'alice-example',
      owner: A,
      target: B,
      expiry: 215_880_000,
      status: 'REGISTERED',
      evm: '',
      host: 'r.example.com',
    })
    expect((await queries.record('nobody-here')).value).toBeNull()

    const detail = await queries.detail('alice-example')
    expect(detail.value.record?.name).toBe('alice-example')
    expect(detail.value.offer).toEqual({
      name: 'alice-example',
      seller: A,
      price: 50_000_000n,
      openedHeight: 58_190_000,
      expiryHeight: 59_486_000,
    })
    expect(detail.value.transfer).toBeNull()
    expect(detail.value.unreserved).toBe(false)

    // A fired `U` is the only kind there is since r22, and `unreserved` is
    // where it shows: the pending row this used to assert cannot be written
    // any more (migration 007 dropped the kind).
    expect((await queries.detail('legacy-brand')).value.unreserved).toBe(true)

    const owned = await queries.byOwner(A)
    expect(owned.value.map((r) => r.name)).toEqual(['alice-example', 'bob-example'])
    expect(owned.value[1]?.status).toBe('GRACE')
    expect(owned.value[1]?.host).toBe('')

    const offers = await queries.offers()
    expect(offers.value).toHaveLength(1)
    expect(offers.value[0]?.price).toBe(50_000_000n)

    const params = await queries.params()
    expect(params).toEqual({
      height: HEIGHT,
      value: {
        feeStandard: 400_000_000n,
        feeLong: 40_000_000n,
        commissionBp: 250n,
        lastGovernanceHeight: 58_150_000,
        pending: { feeStandard: 800_000_000n, feeLong: 80_000_000n, commissionBp: 300n, effectiveHeight: 58_243_200 },
        // No `verification` row: this database was replayed from the chain,
        // which is what an absent row means and the strongest answer there is.
        verification: { verifiedFrom: CONSTANTS.LAUNCH_HEIGHT, bootstrap: null },
      },
    })
  })

  it('discloses a bootstrap when the indexer recorded one (§8.4 tiers)', async () => {
    await pool.query(
      `INSERT INTO verification (id, verified_from, bootstrap_height, bootstrap_source, shadow_through)
       VALUES (TRUE, $1, $2, $3, $4)`,
      [HEIGHT, HEIGHT - 60, 'https://peer.example.com', HEIGHT - 100_000],
    )
    try {
      const params = await queries.params()
      expect(params.value.verification).toEqual({
        verifiedFrom: HEIGHT,
        bootstrap: {
          height: HEIGHT - 60,
          source: 'https://peer.example.com',
          verifiedThrough: HEIGHT - 100_000,
        },
      })
    } finally {
      await pool.query('DELETE FROM verification')
    }
  })

  it('the GOVERNANCE pending row never leaks into a name detail', async () => {
    // Impossible via §4.1 (the empty name is invalid), but the query must not
    // depend on the caller having validated first.
    const detail = await queries.detail('')
    expect(detail.value).toEqual({
      record: null,
      transfer: null,
      offer: null,
      unreserved: false,
    })
  })
})

// ── Checkpoint-derived reads: proofs, the log, settlements, the burn ─────────

const CP_HEIGHT = 58_198_320 // a multiple of 720, at or below HEIGHT

const record = (name: string, over: Partial<ApiNameRecord> = {}): ApiNameRecord => ({
  name,
  owner: A,
  target: B,
  expiry: 215_880_000,
  status: 'REGISTERED',
  evm: '',
  host: '',
  ...over,
})

/** The done-when, over real SQL: rebuild the leaf from the served fields, core only. */
function docVerifies(doc: Record<string, unknown>, rootHex0x: string): boolean {
  const leaf: NameRecord = {
    name: doc['name'] as string,
    owner: parseAddress(doc['owner'] as string),
    target: parseAddress(doc['target'] as string),
    evm: doc['evm'] as string,
    expiry: doc['expiry'] as number,
    status: doc['status'] as NameStatus,
    host: doc['delegate'] as string,
  }
  const steps: ProofStep[] = (doc['proof'] as { hash: string; side: 'left' | 'right' }[]).map((step) => ({
    hash: Buffer.from(step.hash.slice(2), 'hex'),
    side: step.side,
  }))
  return verifyProof(leafHash(leaf), steps, Buffer.from(rootHex0x.slice(2), 'hex'))
}

describe.skipIf(URL === undefined)('PgQueries — checkpoint reads', () => {
  const pool = createPool(POOL_URL)
  const queries = new PgQueries(pool)
  const handle = createRoutes(queries)

  afterAll(async () => {
    await pool.end()
  })

  // A non-empty `evm` (r26) rides one record on purpose: were the column
  // dropped anywhere between `checkpoint_names` and the leaf, the derived
  // root would not match and every proof here would vanish.
  const EVM = `0x${'ab'.repeat(20)}`
  const treeRecords = [
    record('alice-example', { host: 'r.example.com' }),
    record('evm-name', { evm: EVM }),
    record('zeta-name'),
  ]
  const coveredRows: LogRow[] = [
    {
      block_height: 58_190_000,
      tx_index: 0,
      tx_hash: 'aa'.repeat(32),
      sender: A,
      recipient: B,
      value: '400000000',
      data: '4e4e533147616c6963652d6578616d706c65',
      verdict: 'OK',
    },
    {
      block_height: 58_190_060,
      tx_index: 1,
      tx_hash: 'bb'.repeat(32),
      sender: B,
      recipient: A,
      value: '1',
      data: '4e4e533153616c6963652d6578616d706c65',
      verdict: 'WRONG_RECIPIENT',
    },
  ]

  it('seeds a checkpoint whose root and log hash the fixtures reproduce', async () => {
    const nameRoot = Buffer.from(merkleRoot({ names: new Map(treeRecords.map((r) => [r.name, r])) }))
    const coveredHash = Buffer.from(logHash(coveredRows.map(logLineFromRow)))

    for (const row of coveredRows) {
      await pool.query(
        `INSERT INTO log (block_height, tx_index, tx_hash, sender, recipient, value, data, verdict)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [row.block_height, row.tx_index, row.tx_hash, row.sender, row.recipient, row.value, row.data, row.verdict],
      )
    }
    // One line above the checkpoint: committed, but outside the covered prefix.
    await pool.query(
      `INSERT INTO log (block_height, tx_index, tx_hash, sender, recipient, value, data, verdict)
       VALUES ($1, 0, $2, $3, $4, '1', '4e4e53314b616c6963652d6578616d706c65', 'OK')`,
      [CP_HEIGHT + 60, 'cc'.repeat(32), A, B],
    )

    const filler = Buffer.alloc(32, 7)
    await pool.query(
      `INSERT INTO checkpoints (height, layout, name_root, prices_root, pending_root, unreserved_root, log_hash, commitment)
       VALUES ($1, 4, $2, $3, $3, $3, $4, $3)`,
      [CP_HEIGHT, nameRoot, filler, coveredHash],
    )
    for (const r of treeRecords) {
      await pool.query(
        `INSERT INTO checkpoint_names (height, name, owner, target, evm, expiry, status, host)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [CP_HEIGHT, r.name, r.owner, r.target, r.evm, r.expiry, r.status, r.host],
      )
    }
    // Live row for the record the proof test resolves; the first suite seeded
    // the others.
    await pool.query(
      `INSERT INTO names (name, owner, target, evm, expiry, status, host)
       VALUES ('evm-name', $1, $2, $3, 215880000, 'REGISTERED', '')`,
      [A, B, EVM],
    )

    const latest = await queries.latestCheckpoint()
    expect(latest.value).toMatchObject({ height: CP_HEIGHT, layout: 4, nameRoot: nameRoot.toString('hex') })

    const base = await queries.proofBase()
    expect(base.value?.records?.size).toBe(3)
  })

  it('serves a checkpoint by exact height, identically to /checkpoints/latest', async () => {
    // Only one checkpoint exists in this fixture, so the two must agree
    // exactly — which is the property the anchor publisher relies on when it
    // asks for the height /log stamped rather than for "latest".
    const byHeight = await handle('GET', `/checkpoints/${CP_HEIGHT}`)
    const latest = await handle('GET', '/checkpoints/latest')
    expect(byHeight.status).toBe(200)
    expect(byHeight.body).toEqual(latest.body)

    const lookup = await queries.checkpointAt(CP_HEIGHT)
    expect(lookup.value.checkpoint).toMatchObject({ height: CP_HEIGHT, layout: 4 })
    // The bounds query does not run on a hit.
    expect(lookup.value.retained).toBeNull()
  })

  it('the publisher pairing works over real SQL: /log stamps a height, that height serves', async () => {
    // The race this endpoint exists to remove. Read /log, take the height it
    // committed to, ask for that exact checkpoint — no compare-and-retry, and
    // the log hash in the header is the one the checkpoint row carries.
    const log = await handle('GET', '/log')
    const stamped = Number(log.headers?.['x-nns-checkpoint-height'])
    expect(stamped).toBe(CP_HEIGHT)

    const checkpoint = await handle('GET', `/checkpoints/${stamped}`)
    expect(checkpoint.status).toBe(200)
    const served = (checkpoint.body as { checkpoint: { logHash: string; height: number } }).checkpoint
    expect(served.height).toBe(stamped)
    expect(served.logHash).toBe(log.headers?.['x-nns-log-hash'])
  })

  it('distinguishes pending, not-retained and malformed over real SQL', async () => {
    const pending = await handle('GET', `/checkpoints/${CP_HEIGHT + 720}`)
    expect(pending.status).toBe(404)
    expect(pending.body).toMatchObject({ error: 'CHECKPOINT_PENDING', latest: CP_HEIGHT })

    const old = await handle('GET', `/checkpoints/${CP_HEIGHT - 720}`)
    expect(old.status).toBe(410)
    expect(old.body).toMatchObject({ error: 'CHECKPOINT_NOT_RETAINED', oldest: CP_HEIGHT })

    const offBoundary = await handle('GET', `/checkpoints/${CP_HEIGHT + 1}`)
    expect(offBoundary.status).toBe(400)
    expect(offBoundary.body).toMatchObject({ error: 'NOT_A_CHECKPOINT_HEIGHT' })
  })

  it('a proof fetched over HTTP routes verifies with core alone — the task-02 done-when', async () => {
    const resolved = await handle('GET', '/resolve/alice-example')
    expect(resolved.status).toBe(200)
    const doc = (resolved.body as { proof: Record<string, unknown> }).proof
    expect(doc).toMatchObject({ nimiq_height: CP_HEIGHT, delegate: 'r.example.com' })

    const checkpointRoute = await handle('GET', '/checkpoints/latest')
    const advertised = (checkpointRoute.body as { checkpoint: { nameRoot: string } }).checkpoint.nameRoot
    expect(doc['root']).toBe(advertised)
    expect(docVerifies(doc, advertised)).toBe(true)
  })

  it('carries a non-empty `evm` from the snapshot into the record and the §8.3 proof (r26)', async () => {
    const resolved = await handle('GET', '/resolve/evm-name')
    expect(resolved.status).toBe(200)
    expect((resolved.body as { evm: string }).evm).toBe(EVM)

    const doc = (resolved.body as { proof: Record<string, unknown> }).proof
    expect(doc['evm']).toBe(EVM)
    expect(docVerifies(doc, doc['root'] as string)).toBe(true)
    // The leaf binds the field: a proof served with `evm` blanked must fail.
    expect(docVerifies({ ...doc, evm: '' }, doc['root'] as string)).toBe(false)
  })

  it('a non-inclusion proof brackets the queried name and both leaves verify', async () => {
    const response = await handle('GET', '/available/gamma-name')
    expect(response.status).toBe(200)
    const body = response.body as { available: boolean; proof: Record<string, unknown> }
    expect(body.available).toBe(true)
    expect(body.proof).toMatchObject({ kind: 'BETWEEN', nimiq_height: CP_HEIGHT })
    for (const side of ['previous', 'next'] as const) {
      expect(docVerifies(body.proof[side] as Record<string, unknown>, body.proof['root'] as string)).toBe(true)
    }
  })

  it('/log serves exactly the §8.2 bytes the checkpoint committed to', async () => {
    const response = await handle('GET', '/log')
    expect(response.status).toBe(200)
    expect(response.body).toEqual(logFile(coveredRows.map(logLineFromRow)))
    expect(response.headers).toMatchObject({
      'x-nns-log-hash': `0x${Buffer.from(logHash(coveredRows.map(logLineFromRow))).toString('hex')}`,
    })
  })

  it('degrades to no proof when the snapshot cannot reproduce the newest root', async () => {
    // A newer checkpoint lands but its snapshot write is missing — the exact
    // state an indexer that predates migration 005 leaves behind. The stale
    // snapshot's height no longer matches, so proofs must vanish rather than
    // verify against the wrong root.
    const filler = Buffer.alloc(32, 9)
    await pool.query(
      `INSERT INTO checkpoints (height, layout, name_root, prices_root, pending_root, unreserved_root, log_hash, commitment)
       VALUES ($1, 4, $2, $2, $2, $2, $2, $2)`,
      [CP_HEIGHT + 720, filler],
    )
    const base = await queries.proofBase()
    expect(base.value?.checkpoint.height).toBe(CP_HEIGHT + 720)
    expect(base.value?.records).toBeNull()

    const resolved = await handle('GET', '/resolve/alice-example')
    expect(resolved.status).toBe(200)
    expect((resolved.body as { proof: unknown }).proof).toBeNull()
  })

  it('lists outstanding settlements, optionally filtered by creditor', async () => {
    await pool.query(
      `INSERT INTO settlements (ref_height, ref_tx_index, ordinal, kind, owed_by, owed_to, amount)
       VALUES (58190001, 3, 0, 'SALE_PROCEEDS', $1, $2, '390000000000'),
              (58190001, 3, 1, 'COMMISSION', $1, $3, '10000000000')`,
      [B, A, C],
    )
    expect((await queries.outstanding(null)).value).toHaveLength(2)
    const filtered = await queries.outstanding(A)
    expect(filtered.value).toHaveLength(1)
    expect(filtered.value[0]?.amount).toBe(390_000_000_000n)
  })

  it('/burn sums accepted attestations and keeps rejected ones visible', async () => {
    await pool.query(
      `INSERT INTO log (block_height, tx_index, tx_hash, sender, recipient, value, data, verdict)
       VALUES (58199000, 0, $1, $2, $4, '100000', '4e4e533146', 'OK'),
              (58199060, 0, $3, $2, $4, '999', '4e4e533146', 'WRONG_SENDER')`,
      ['dd'.repeat(32), A, 'ee'.repeat(32), BURN_ADDRESS],
    )
    const response = await handle('GET', '/burn')
    const body = response.body as { burned: string; attestations: unknown[] }
    expect(body.burned).toBe('100000')
    expect(body.attestations).toHaveLength(2)
  })

  it('computes the owed half from accepted revenue only — §10.2 as r24 pins it', async () => {
    // Five lines around the treasury; only the first two are base. An OK G
    // (counts) and an OK M commission (counts); a refund-class G (excluded —
    // §7.4 sends that money back, and until its M lands it sits in the
    // balance without being revenue); an OK S dust that happens to name the
    // treasury as counterparty (excluded — a counterparty choice, not a
    // fee); and the refund M *leaving* the treasury (excluded — an outflow).
    // The balance sees all five, which is exactly why r24 defines the base
    // over the log and not the balance.
    // Base 250,000,000 → owed 20% = 50,000,000.
    await pool.query(
      `INSERT INTO log (block_height, tx_index, tx_hash, sender, recipient, value, data, verdict)
       VALUES (58199240, 0, $1, $2, $3, '200000000', '4e4e5331476e616d65746573746161', 'OK'),
              (58199300, 0, $4, $2, $3, '50000000', '4e4e53314d35383139393030307c30', 'OK'),
              (58199360, 0, $5, $2, $3, '200000000', '4e4e5331476e616d65746573746161', 'NAME_TAKEN'),
              (58199420, 0, $6, $2, $3, '1', '4e4e533153746573746e616d65', 'OK'),
              (58199480, 0, $7, $3, $2, '120000000', '4e4e53314d35383139393336307c30', 'OK')`,
      ['f1'.repeat(32), A, CONSTANTS.TREASURY_ADDRESS, 'f2'.repeat(32), 'f3'.repeat(32), 'f4'.repeat(32), 'f5'.repeat(32)],
    )
    const body = (await handle('GET', '/burn')).body as { revenue: string; owed: string; burned: string }
    expect(body.revenue).toBe('250000000')
    expect(body.owed).toBe('50000000')
    // The attestation sum is untouched by revenue rows.
    expect(body.burned).toBe('100000')
  })

  it('counts only `F`, not everything addressed to BURN_ADDRESS', async () => {
    // Found by the 2026-08-14 battery, which filtered by recipient alone: an
    // `S` pointing a name at the burn address — a legitimate "resolves
    // nowhere" — and a `U` awarding to it, which the reducer *rejects*, both
    // carry DUST_VALUE there and both showed up as burn attestations. Neither
    // burned anything anybody attested to.
    await pool.query(
      `INSERT INTO log (block_height, tx_index, tx_hash, sender, recipient, value, data, verdict)
       VALUES (58199120, 0, $1, $2, $4, '1', '4e4e533153746573746e616d65', 'OK'),
              (58199180, 0, $3, $2, $4, '1', '4e4e5331557465737400', 'INVALID_RECIPIENT')`,
      ['aa'.repeat(32), A, 'bb'.repeat(32), BURN_ADDRESS],
    )
    const body = (await handle('GET', '/burn')).body as { burned: string; attestations: unknown[] }
    expect(body.burned).toBe('100000')
    expect(body.attestations).toHaveLength(2)
  })
})
