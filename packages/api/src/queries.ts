/**
 * Reads over the indexer's tables — the only file that speaks SQL.
 *
 * Every request runs inside one `REPEATABLE READ, READ ONLY` transaction, so
 * all of its rows come from a single snapshot and the `height` on the
 * response is true of every field next to it. The indexer commits each batch
 * atomically; without the snapshot, a commit landing between two of our
 * statements could pair one batch's height with the next batch's rows.
 *
 * `height` is `params.state_height`: the height whose scheduled effects the
 * indexer has fully applied. Serving it on every response is the same free
 * "as of block" stamp the RPC's `metadata` gives state reads.
 */

import { parseAddress, type Address, type NameStatus } from '@nns/core'
import { toHeight, toLuna } from '@nns/indexer'
import type { Pool, PoolClient } from 'pg'

/** The database is present but the indexer has not initialised it yet. */
export class NotSyncedError extends Error {
  override readonly name = 'NotSyncedError'
}

export class QueryError extends Error {
  override readonly name = 'QueryError'
}

/** A `names` row, in `core` types. */
export interface ApiNameRecord {
  readonly name: string
  readonly owner: Address
  readonly target: Address
  readonly expiry: number
  readonly status: NameStatus
  readonly recovery: Address | null
  readonly host: string
}

/** An open `O` from the pending set (§6 `O`). */
export interface ApiOffer {
  readonly name: string
  readonly seller: Address
  readonly price: bigint
  readonly openedHeight: number
  readonly expiryHeight: number
}

export interface ApiPendingTransfer {
  readonly newOwner: Address
  readonly effectiveHeight: number
  readonly viaRecovery: boolean
}

/** `recovery: null` is a clearing operation, not an absent field (§6 `R`). */
export interface ApiPendingRecovery {
  readonly recovery: Address | null
  readonly effectiveHeight: number
}

/** `recipient: null` is a release; an address is an award (§6 `U`, r17). */
export interface ApiPendingUnreserve {
  readonly recipient: Address | null
  readonly effectiveHeight: number
}

/** Everything the state knows about one name. */
export interface NameDetail {
  readonly record: ApiNameRecord | null
  readonly transfer: ApiPendingTransfer | null
  readonly recovery: ApiPendingRecovery | null
  readonly offer: ApiOffer | null
  readonly unreserve: ApiPendingUnreserve | null
  /** The name's `U` has fired — it is off the reserved list for good. */
  readonly unreserved: boolean
}

export interface ParamsSnapshot {
  readonly feeStandard: bigint
  readonly feeLong: bigint
  readonly commissionBp: bigint
  readonly lastGovernanceHeight: number | null
  /** A scheduled `P` that has not activated yet (§10.6). */
  readonly pending: {
    readonly feeStandard: bigint
    readonly feeLong: bigint
    readonly commissionBp: bigint
    readonly effectiveHeight: number
  } | null
}

/** A value plus the state height it was read at. */
export interface Snapshot<T> {
  readonly height: number
  readonly value: T
}

export interface Queries {
  /** The bare record, for the resolution hot path. */
  record(name: string): Promise<Snapshot<ApiNameRecord | null>>
  detail(name: string): Promise<Snapshot<NameDetail>>
  byOwner(owner: Address): Promise<Snapshot<readonly ApiNameRecord[]>>
  offers(): Promise<Snapshot<readonly ApiOffer[]>>
  params(): Promise<Snapshot<ParamsSnapshot>>
}

// ── Row mapping ─────────────────────────────────────────────────────────────

type Row = Record<string, unknown>

function text(row: Row, field: string): string {
  const value = row[field]
  if (typeof value !== 'string') throw new QueryError(`${field}: expected text, got ${JSON.stringify(value)}`)
  return value
}

function address(row: Row, field: string): Address {
  return parseAddress(text(row, field))
}

function nullableAddress(row: Row, field: string): Address | null {
  return row[field] === null ? null : address(row, field)
}

function status(row: Row): NameStatus {
  const value = text(row, 'status')
  if (value !== 'REGISTERED' && value !== 'GRACE') throw new QueryError(`status: ${JSON.stringify(value)}`)
  return value
}

function nameRecord(row: Row): ApiNameRecord {
  return {
    name: text(row, 'name'),
    owner: address(row, 'owner'),
    target: address(row, 'target'),
    expiry: toHeight(row['expiry'], 'expiry'),
    status: status(row),
    recovery: nullableAddress(row, 'recovery'),
    host: text(row, 'host'),
  }
}

function offer(row: Row): ApiOffer {
  return {
    name: text(row, 'name'),
    seller: address(row, 'seller'),
    price: toLuna(row['price'], 'price'),
    openedHeight: toHeight(row['opened_height'], 'opened_height'),
    expiryHeight: toHeight(row['expiry_height'], 'expiry_height'),
  }
}

const NAME_COLUMNS = 'name, owner, target, expiry, status, recovery, host'

// ── Postgres implementation ─────────────────────────────────────────────────

const UNDEFINED_TABLE = '42P01'

export class PgQueries implements Queries {
  readonly #pool: Pool

  constructor(pool: Pool) {
    this.#pool = pool
  }

  /**
   * One snapshot per request. The `params` read doubles as the sync probe:
   * no row (or no table at all) means the indexer has never initialised this
   * database, which is a 503, not a 500.
   */
  async #snapshot<T>(work: (client: PoolClient) => Promise<T>): Promise<Snapshot<T>> {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const params = await client.query('SELECT state_height FROM params')
      const row: Row | undefined = params.rows[0]
      if (row === undefined) throw new NotSyncedError('the indexer has not written state yet')
      const height = toHeight(row['state_height'], 'state_height')
      const value = await work(client)
      await client.query('COMMIT')
      return { height, value }
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // The original error is the one worth reporting.
      }
      if (isUndefinedTable(error)) throw new NotSyncedError('the indexer has not migrated this database yet')
      throw error
    } finally {
      client.release()
    }
  }

  async record(name: string): Promise<Snapshot<ApiNameRecord | null>> {
    return this.#snapshot(async (client) => {
      const result = await client.query(`SELECT ${NAME_COLUMNS} FROM names WHERE name = $1`, [name])
      const row: Row | undefined = result.rows[0]
      return row === undefined ? null : nameRecord(row)
    })
  }

  async detail(name: string): Promise<Snapshot<NameDetail>> {
    return this.#snapshot(async (client) => {
      // Sequential on purpose: a pg client cannot run queries concurrently,
      // and issuing them anyway relies on deprecated internal queueing.
      const names = await client.query(`SELECT ${NAME_COLUMNS} FROM names WHERE name = $1`, [name])
      const pending = await client.query(
        `SELECT kind, effective_height, new_owner, via_recovery, recovery,
                seller, price, opened_height, expiry_height, recipient
           FROM pending WHERE name = $1`,
        [name],
      )
      const unreserved = await client.query('SELECT 1 FROM unreserved WHERE name = $1', [name])

      const record: Row | undefined = names.rows[0]
      let transfer: ApiPendingTransfer | null = null
      let recovery: ApiPendingRecovery | null = null
      let openOffer: ApiOffer | null = null
      let unreserve: ApiPendingUnreserve | null = null

      for (const row of pending.rows as Row[]) {
        switch (text(row, 'kind')) {
          case 'TRANSFER':
            transfer = {
              newOwner: address(row, 'new_owner'),
              effectiveHeight: toHeight(row['effective_height'], 'effective_height'),
              viaRecovery: row['via_recovery'] === true,
            }
            break
          case 'RECOVERY':
            recovery = {
              recovery: nullableAddress(row, 'recovery'),
              effectiveHeight: toHeight(row['effective_height'], 'effective_height'),
            }
            break
          case 'OFFER':
            openOffer = offer({ ...row, name })
            break
          case 'UNRESERVE':
            unreserve = {
              recipient: nullableAddress(row, 'recipient'),
              effectiveHeight: toHeight(row['effective_height'], 'effective_height'),
            }
            break
          case 'GOVERNANCE':
            // Keyed on the empty name, so no §4.1-valid name can match it —
            // but this query must not rely on the caller having validated.
            break
          default:
            throw new QueryError(`pending row of unknown kind ${JSON.stringify(row['kind'])}`)
        }
      }

      return {
        record: record === undefined ? null : nameRecord(record),
        transfer,
        recovery,
        offer: openOffer,
        unreserve,
        unreserved: unreserved.rows.length > 0,
      }
    })
  }

  async byOwner(owner: Address): Promise<Snapshot<readonly ApiNameRecord[]>> {
    return this.#snapshot(async (client) => {
      const result = await client.query(
        `SELECT ${NAME_COLUMNS} FROM names WHERE owner = $1 ORDER BY name`,
        [owner],
      )
      return (result.rows as Row[]).map(nameRecord)
    })
  }

  async offers(): Promise<Snapshot<readonly ApiOffer[]>> {
    return this.#snapshot(async (client) => {
      const result = await client.query(
        `SELECT name, seller, price, opened_height, expiry_height
           FROM pending WHERE kind = 'OFFER' ORDER BY name`,
      )
      return (result.rows as Row[]).map(offer)
    })
  }

  async params(): Promise<Snapshot<ParamsSnapshot>> {
    return this.#snapshot(async (client) => {
      const params = await client.query(
        'SELECT fee_standard, fee_long, commission_bp, last_governance_height FROM params',
      )
      const governance = await client.query(
        `SELECT fee_standard, fee_long, commission_bp, effective_height
           FROM pending WHERE kind = 'GOVERNANCE'`,
      )
      // #snapshot has already proven the params row exists.
      const row = params.rows[0] as Row
      const scheduled: Row | undefined = governance.rows[0]
      return {
        feeStandard: toLuna(row['fee_standard'], 'fee_standard'),
        feeLong: toLuna(row['fee_long'], 'fee_long'),
        commissionBp: toLuna(row['commission_bp'], 'commission_bp'),
        lastGovernanceHeight:
          row['last_governance_height'] === null
            ? null
            : toHeight(row['last_governance_height'], 'last_governance_height'),
        pending:
          scheduled === undefined
            ? null
            : {
                feeStandard: toLuna(scheduled['fee_standard'], 'fee_standard'),
                feeLong: toLuna(scheduled['fee_long'], 'fee_long'),
                commissionBp: toLuna(scheduled['commission_bp'], 'commission_bp'),
                effectiveHeight: toHeight(scheduled['effective_height'], 'effective_height'),
              },
      }
    })
  }
}

function isUndefinedTable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNDEFINED_TABLE
  )
}
