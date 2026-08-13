/**
 * PgQueries integration — **needs a real Postgres**, and is skipped without one.
 *
 *   NNS_TEST_DATABASE_URL=postgres://…/nns_test pnpm vitest run --project api
 *
 * It drops and recreates the `public` schema, so point it at a throwaway
 * database. The schema comes from the indexer's own migrations — the API has
 * none of its own, which is the point: these tests read exactly the tables
 * the indexer writes, in the shape migration `004` leaves them.
 */

import { parseAddress } from '@nns/core'
import { createPool, migrate } from '@nns/indexer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { NotSyncedError, PgQueries } from './queries.js'

const URL = process.env['NNS_TEST_DATABASE_URL']
const A = parseAddress('NQ34 248H 248H 248H 248H 248H 248H 248H 248H')
const B = parseAddress('NQ93 48H2 48H2 48H2 48H2 48H2 48H2 48H2 48H2')
const C = parseAddress('NQ60 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK')

const HEIGHT = 58_200_000

describe.skipIf(URL === undefined)('PgQueries', () => {
  const pool = createPool(URL ?? '')
  const queries = new PgQueries(pool)

  beforeAll(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
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
      `INSERT INTO names (name, owner, target, expiry, status, recovery, host)
       VALUES ('alice-example', $1, $2, 215880000, 'REGISTERED', $3, 'r.example.com'),
              ('bob-example', $1, $1, 58190000, 'GRACE', NULL, '')`,
      [A, B, C],
    )
    await pool.query(
      `INSERT INTO pending (kind, name, seller, price, opened_height, expiry_height)
       VALUES ('OFFER', 'alice-example', $1, '50000000', 58190000, 59486000)`,
      [A],
    )
    await pool.query(
      `INSERT INTO pending (kind, name, effective_height, recipient)
       VALUES ('UNRESERVE', 'nimiq', 58250000, $1)`,
      [C],
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
      recovery: C,
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

    // The pending `U` and the fired one are different tables and both visible.
    const nimiq = await queries.detail('nimiq')
    expect(nimiq.value.unreserve).toEqual({ recipient: C, effectiveHeight: 58_250_000 })
    expect((await queries.detail('legacy-brand')).value.unreserved).toBe(true)

    const owned = await queries.byOwner(A)
    expect(owned.value.map((r) => r.name)).toEqual(['alice-example', 'bob-example'])
    expect(owned.value[1]?.status).toBe('GRACE')
    expect(owned.value[1]?.recovery).toBeNull()

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
      },
    })
  })

  it('the GOVERNANCE pending row never leaks into a name detail', async () => {
    // Impossible via §4.1 (the empty name is invalid), but the query must not
    // depend on the caller having validated first.
    const detail = await queries.detail('')
    expect(detail.value).toEqual({
      record: null,
      transfer: null,
      recovery: null,
      offer: null,
      unreserve: null,
      unreserved: false,
    })
  })
})
