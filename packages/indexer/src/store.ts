/**
 * The database side of the indexer: load state on start, commit each batch.
 *
 * **One transaction per batch, and the cursor moves inside it.** State rows,
 * log lines and the cursor are written together or not at all, so a crash can
 * only lose a batch's work — never half-apply one. Recovery is then just
 * "resume at `next_batch`", with no reconciliation pass and nothing to repair.
 */

import { createHash } from 'node:crypto'

import { initialState, type NnsConfig, type NnsState } from '@nns/core'
import type { Pool, PoolClient } from 'pg'

import { excluded, insertRows, withTransaction } from './db.js'
import { diffState, type StateDiff } from './diff.js'
import type { Logger } from './logger.js'
import {
  stateFromRows,
  type LogRow,
  type NameRow,
  type ParamsRow,
  type PendingRow,
  type SettlementRow,
} from './rows.js'

export class StoreError extends Error {
  override readonly name = 'StoreError'
}

export interface Cursor {
  nextBatch: number
  scannedThrough: number
  configFingerprint: string
}

const NAME_COLUMNS = ['name', 'owner', 'target', 'expiry', 'status', 'recovery', 'host'] as const
const PENDING_COLUMNS = [
  'kind',
  'name',
  'effective_height',
  'new_owner',
  'via_recovery',
  'recovery',
  'seller',
  'price',
  'opened_height',
  'expiry_height',
  'fee_standard',
  'fee_long',
  'commission_bp',
] as const
const SETTLEMENT_COLUMNS = [
  'ref_height',
  'ref_tx_index',
  'ordinal',
  'kind',
  'owed_by',
  'owed_to',
  'amount',
] as const
const LOG_COLUMNS = [
  'block_height',
  'tx_index',
  'tx_hash',
  'sender',
  'recipient',
  'value',
  'data',
  'verdict',
] as const

/**
 * Identity of the deployment config, so a restart against a database built
 * under different §3 values fails instead of continuing on top of rows that
 * are no longer valid. Moving `LAUNCH_HEIGHT`, or adding a reserved name,
 * changes what a replay from scratch would have produced.
 */
export function configFingerprint(config: NnsConfig): string {
  const payload = JSON.stringify({
    networkId: config.networkId,
    launchHeight: config.launchHeight,
    treasury: config.treasury,
    protocol: config.protocol,
    admin: config.admin,
    marketplace: config.marketplace,
    listingFee: config.listingFee.toString(10),
    reservedNames: [...config.reservedNames].sort(),
  })
  return createHash('sha256').update(payload).digest('hex')
}

export interface CommitInput {
  /** The state the batch started from — `null` on the very first commit. */
  before: NnsState | null
  after: NnsState
  logRows: readonly LogRow[]
  nextBatch: number
  scannedThrough: number
}

export class Store {
  private readonly pool: Pool
  private readonly config: NnsConfig
  private readonly logger: Logger
  private readonly fingerprint: string

  constructor(pool: Pool, config: NnsConfig, logger: Logger) {
    this.pool = pool
    this.config = config
    this.logger = logger
    this.fingerprint = configFingerprint(config)
  }

  /**
   * The stored cursor, or `null` for a database that has never run.
   *
   * @throws {StoreError} if the stored config fingerprint disagrees with ours.
   */
  async loadCursor(): Promise<Cursor | null> {
    const result = await this.pool.query<{
      next_batch: number
      scanned_through: number
      config_fingerprint: string
    }>('SELECT next_batch, scanned_through, config_fingerprint FROM "cursor" WHERE id')
    const row = result.rows[0]
    if (row === undefined) return null
    if (row.config_fingerprint !== this.fingerprint) {
      throw new StoreError(
        'this database was built under a different deployment config (§3 values changed). ' +
          'Every row above LAUNCH_HEIGHT depends on them, so continuing would mix two histories. ' +
          'Rebuild from empty, or restore the previous config. ' +
          `stored=${row.config_fingerprint.slice(0, 12)} current=${this.fingerprint.slice(0, 12)}`,
      )
    }
    return {
      nextBatch: row.next_batch,
      scannedThrough: row.scanned_through,
      configFingerprint: row.config_fingerprint,
    }
  }

  /**
   * Reload state from the tables, or the empty state at `LAUNCH_HEIGHT` when
   * nothing has been written (§7.2 step 1).
   */
  async loadState(): Promise<NnsState> {
    const params = await this.pool.query<ParamsRow>(
      `SELECT fee_standard, fee_long, commission_bp, last_governance_height, state_height, next_due_height
       FROM params WHERE id`,
    )
    const paramsRow = params.rows[0]
    if (paramsRow === undefined) return initialState(this.config)

    const [names, pending, unreserved, settlements] = await Promise.all([
      this.pool.query<NameRow>(`SELECT ${NAME_COLUMNS.join(', ')} FROM names`),
      this.pool.query<PendingRow>(`SELECT ${PENDING_COLUMNS.join(', ')} FROM pending`),
      this.pool.query<{ name: string }>('SELECT name FROM unreserved'),
      this.pool.query<SettlementRow>(`SELECT ${SETTLEMENT_COLUMNS.join(', ')} FROM settlements`),
    ])

    const state = stateFromRows({
      names: names.rows,
      pending: pending.rows,
      unreserved: unreserved.rows.map((row) => row.name),
      settlements: settlements.rows,
      params: paramsRow,
    })
    this.logger.info('store.loaded', {
      height: state.height,
      names: state.names.size,
      pending: pending.rows.length,
      outstanding: settlements.rows.length,
    })
    return state
  }

  /** Apply one batch's state change, log lines and cursor, atomically. */
  async commitBatch(input: CommitInput): Promise<void> {
    const diff = diffState(input.before, input.after)
    await withTransaction(this.pool, async (client) => {
      if (diff.hasRowChanges) await this.writeDiff(client, diff)
      await this.writeParams(client, diff.params)
      await insertRows(client, 'log', LOG_COLUMNS, input.logRows, 'DO NOTHING')
      await client.query(
        `INSERT INTO "cursor" (id, next_batch, scanned_through, config_fingerprint, updated_at)
         VALUES (TRUE, $1, $2, $3, now())
         ON CONFLICT (id) DO UPDATE
           SET next_batch = EXCLUDED.next_batch,
               scanned_through = EXCLUDED.scanned_through,
               updated_at = now()`,
        [input.nextBatch, input.scannedThrough, this.fingerprint],
      )
    })
  }

  private async writeDiff(client: PoolClient, diff: StateDiff): Promise<void> {
    if (diff.names.remove.length > 0) {
      await client.query('DELETE FROM names WHERE name = ANY($1::text[])', [diff.names.remove])
    }
    await insertRows(
      client,
      'names',
      NAME_COLUMNS,
      diff.names.upsert,
      `(name) DO UPDATE SET ${excluded(NAME_COLUMNS.slice(1))}`,
    )

    if (diff.pending.remove.length > 0) {
      await client.query(
        `DELETE FROM pending WHERE (kind, name) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
        [diff.pending.remove.map((key) => key.kind), diff.pending.remove.map((key) => key.name)],
      )
    }
    await insertRows(
      client,
      'pending',
      PENDING_COLUMNS,
      diff.pending.upsert,
      `(kind, name) DO UPDATE SET ${excluded(PENDING_COLUMNS.slice(2))}`,
    )

    if (diff.unreserved.remove.length > 0) {
      await client.query('DELETE FROM unreserved WHERE name = ANY($1::text[])', [diff.unreserved.remove])
    }
    await insertRows(
      client,
      'unreserved',
      ['name'],
      diff.unreserved.add.map((name) => ({ name })),
      'DO NOTHING',
    )

    // Obligations are replaced per owing transaction: their order within one
    // transaction is significant, so `remove` must precede `upsert`.
    if (diff.settlements.remove.length > 0) {
      await client.query(
        `DELETE FROM settlements
         WHERE (ref_height, ref_tx_index) IN (SELECT * FROM unnest($1::bigint[], $2::int[]))`,
        [diff.settlements.remove.map((ref) => ref.height), diff.settlements.remove.map((ref) => ref.txIndex)],
      )
    }
    await insertRows(
      client,
      'settlements',
      SETTLEMENT_COLUMNS,
      diff.settlements.upsert,
    )
  }

  private async writeParams(client: PoolClient, params: ParamsRow): Promise<void> {
    await client.query(
      `INSERT INTO params (id, fee_standard, fee_long, commission_bp,
                           last_governance_height, state_height, next_due_height)
       VALUES (TRUE, $1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE
         SET fee_standard = EXCLUDED.fee_standard,
             fee_long = EXCLUDED.fee_long,
             commission_bp = EXCLUDED.commission_bp,
             last_governance_height = EXCLUDED.last_governance_height,
             state_height = EXCLUDED.state_height,
             next_due_height = EXCLUDED.next_due_height`,
      [
        params.fee_standard,
        params.fee_long,
        params.commission_bp,
        params.last_governance_height,
        params.state_height,
        params.next_due_height,
      ],
    )
  }
}
