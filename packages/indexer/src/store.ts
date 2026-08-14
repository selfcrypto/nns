/**
 * The database side of the indexer: load state on start, commit each batch.
 *
 * **One transaction per batch, and the cursor moves inside it.** State rows,
 * log lines and the cursor are written together or not at all, so a crash can
 * only lose a batch's work — never half-apply one. Recovery is then just
 * "resume at `next_batch`", with no reconciliation pass and nothing to repair.
 */

import { createHash } from 'node:crypto'

import { CONSTANTS, initialState, type Checkpoint, type NnsConfig, type NnsState } from '@nns/core'
import type { Pool, PoolClient } from 'pg'

import { checkpointRow, hex, type CheckpointRow } from './checkpoint.js'
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
  'recipient',
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
const CHECKPOINT_COLUMNS = [
  'height',
  'layout',
  'name_root',
  'prices_root',
  'pending_root',
  'unreserved_root',
  'log_hash',
  'commitment',
] as const

/**
 * Identity of the §3 values a replay depends on, so a restart against a
 * database built under different ones fails instead of continuing on top of
 * rows that are no longer valid. Moving `LAUNCH_HEIGHT`, or adding a reserved
 * name, changes what a replay from scratch would have produced.
 *
 * `RESERVED_NAMES` and `LISTING_FEE` are `CONSTANTS` since the launch freeze
 * and are hashed from there rather than from the config. They are kept in
 * **because the list is still expected to move before `LAUNCH_HEIGHT`** —
 * adding an entry is free until then (§10.6 puts additions out of governance
 * scope afterwards), and resuming a battery database across such an edit is
 * exactly the silent divergence this digest exists to turn into a refusal.
 * The list is sorted first: order is not protocol (§4.1 is exact-match
 * membership), so resorting the constant must not invalidate a database.
 */
export function configFingerprint(config: NnsConfig): string {
  const payload = JSON.stringify({
    networkId: config.networkId,
    launchHeight: CONSTANTS.LAUNCH_HEIGHT,
    treasury: CONSTANTS.TREASURY_ADDRESS,
    protocol: CONSTANTS.PROTOCOL_ADDRESS,
    admin: CONSTANTS.ADMIN_ADDRESS,
    marketplace: CONSTANTS.MARKETPLACE_ADDRESS,
    listingFee: CONSTANTS.LISTING_FEE.toString(10),
    reservedNames: [...CONSTANTS.RESERVED_NAMES].sort(),
  })
  return createHash('sha256').update(payload).digest('hex')
}

export interface CommitInput {
  /** The state the batch started from — `null` on the very first commit. */
  before: NnsState | null
  after: NnsState
  logRows: readonly LogRow[]
  /**
   * §8.1 checkpoints due inside this batch. They go in the same transaction as
   * the log rows they commit to: a checkpoint that survived a crash the rows
   * behind it did not would be a root nothing can reproduce.
   */
  checkpoints?: readonly Checkpoint[]
  /**
   * The name records at the highest checkpoint this batch crossed, for the
   * API's §8.3 proofs (migration `005`). Same transaction as the checkpoint
   * row, so `checkpoint_names` can never disagree with `checkpoints` about
   * which height it snapshots.
   */
  snapshot?: { readonly height: number; readonly names: readonly NameRow[] }
  nextBatch: number
  scannedThrough: number
}

/** A checkpoint as stored, hex-encoded. `BYTEA` comes back as a `Buffer`. */
export interface StoredCheckpoint {
  height: number
  layout: number
  nameRoot: string
  pricesRoot: string
  pendingRoot: string
  /** `null` on a layout `1` row, whose commitment function had no such digest. */
  unreservedRoot: string | null
  logHash: string
  commitment: string
}

type CheckpointDbRow = {
  height: number
  layout: number
  name_root: Buffer
  prices_root: Buffer
  pending_root: Buffer
  unreserved_root: Buffer | null
  log_hash: Buffer
  commitment: Buffer
}

const readCheckpoint = (row: CheckpointDbRow): StoredCheckpoint => ({
  height: row.height,
  layout: row.layout,
  nameRoot: row.name_root.toString('hex'),
  pricesRoot: row.prices_root.toString('hex'),
  pendingRoot: row.pending_root.toString('hex'),
  unreservedRoot: row.unreserved_root?.toString('hex') ?? null,
  logHash: row.log_hash.toString('hex'),
  commitment: row.commitment.toString('hex'),
})

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
    if (paramsRow === undefined) return initialState()

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

  /**
   * Every committed log row, in canonical order, fed to `onRow`.
   *
   * The restart path for the §8.2 log hash: state is reloaded from the tables
   * rather than replayed, but the log hash is a fold over every line ever
   * written, so it has to be rebuilt from the table.
   *
   * Read in keyset-paginated chunks. The log is small by design (§8.2 — under
   * 15 MB at 100k messages), but "small" is a property of the protocol's
   * incentives, not of this query, and a single unbounded `SELECT` would put
   * the whole of it in one array.
   *
   * @returns the number of rows streamed.
   */
  async streamLogRows(onRow: (row: LogRow) => void, chunkSize = 10_000): Promise<number> {
    let after: readonly [number, number] = [-1, -1]
    let total = 0
    for (;;) {
      const page = await this.pool.query<LogRow>(
        `SELECT ${LOG_COLUMNS.join(', ')} FROM log
         WHERE (block_height, tx_index) > ($1::bigint, $2::int)
         ORDER BY block_height, tx_index
         LIMIT $3`,
        [after[0], after[1], chunkSize],
      )
      for (const row of page.rows) onRow(row)
      total += page.rows.length
      const last = page.rows[page.rows.length - 1]
      if (last === undefined || page.rows.length < chunkSize) return total
      after = [last.block_height, last.tx_index]
    }
  }

  /** The highest checkpoint written, or `null` for a database with none. */
  async latestCheckpoint(): Promise<StoredCheckpoint | null> {
    const result = await this.pool.query<CheckpointDbRow>(
      `SELECT ${CHECKPOINT_COLUMNS.join(', ')} FROM checkpoints ORDER BY height DESC LIMIT 1`,
    )
    const row = result.rows[0]
    return row === undefined ? null : readCheckpoint(row)
  }

  async checkpointAt(height: number): Promise<StoredCheckpoint | null> {
    const result = await this.pool.query<CheckpointDbRow>(
      `SELECT ${CHECKPOINT_COLUMNS.join(', ')} FROM checkpoints WHERE height = $1`,
      [height],
    )
    const row = result.rows[0]
    return row === undefined ? null : readCheckpoint(row)
  }

  /** Apply one batch's state change, log lines, checkpoints and cursor, atomically. */
  async commitBatch(input: CommitInput): Promise<void> {
    const diff = diffState(input.before, input.after)
    await withTransaction(this.pool, async (client) => {
      if (diff.hasRowChanges) await this.writeDiff(client, diff)
      await this.writeParams(client, diff.params)
      await insertRows(client, 'log', LOG_COLUMNS, input.logRows, 'DO NOTHING')
      await this.writeCheckpoints(client, input.checkpoints ?? [])
      if (input.snapshot !== undefined) await this.writeSnapshot(client, input.snapshot)
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

  /**
   * Insert this batch's checkpoints, and **refuse to overwrite one that
   * disagrees**.
   *
   * A height already present should be one of two things: the same batch
   * replayed after a crash — the cursor moves in this transaction, so a crash
   * before it commits replays the batch and recomputes an identical row — or a
   * divergence, which is the single failure mode this whole design exists to
   * catch. A plain `DO NOTHING` cannot tell those apart, and would keep the
   * first value while the indexer carried on producing the second. So a
   * conflict is read back and compared, and a mismatch stops the process.
   */
  private async writeCheckpoints(client: PoolClient, records: readonly Checkpoint[]): Promise<void> {
    for (const record of records) {
      const row = checkpointRow(record)
      const inserted = await client.query(
        `INSERT INTO checkpoints (${CHECKPOINT_COLUMNS.join(', ')})
         VALUES (${CHECKPOINT_COLUMNS.map((_, index) => `$${index + 1}`).join(', ')})
         ON CONFLICT (height) DO NOTHING`,
        CHECKPOINT_COLUMNS.map((column) => row[column]),
      )
      if (inserted.rowCount !== 0) continue

      const existing = await client.query<CheckpointDbRow>(
        `SELECT ${CHECKPOINT_COLUMNS.join(', ')} FROM checkpoints WHERE height = $1`,
        [record.height],
      )
      const stored = existing.rows[0]
      if (stored !== undefined && stored.commitment.equals(row.commitment) && stored.layout === row.layout) {
        this.logger.debug('checkpoint.replayed', { height: record.height, commitment: hex(record.commitment) })
        continue
      }
      throw new StoreError(
        `checkpoint divergence at height ${record.height}: this run computed ` +
          `${hex(record.commitment)} (layout ${row.layout}), the database holds ` +
          `${stored?.commitment.toString('hex') ?? 'nothing'} (layout ${stored?.layout ?? '?'}). ` +
          'Two derivations of the same height cannot both be right — do not overwrite either; ' +
          'find which rule they disagree on.',
      )
    }
  }

  /**
   * Replace the proof snapshot wholesale. A full rewrite every
   * `CHECKPOINT_INTERVAL` is deliberate simplicity — the table is one
   * checkpoint's name records, and a diff against the previous snapshot would
   * be a second copy of `diff.ts` guarding a projection that a wrong write
   * cannot corrupt anyway: the API re-derives the root and refuses to serve
   * proofs from a snapshot that does not reproduce `checkpoints.name_root`.
   */
  private async writeSnapshot(
    client: PoolClient,
    snapshot: NonNullable<CommitInput['snapshot']>,
  ): Promise<void> {
    await client.query('DELETE FROM checkpoint_names')
    await insertRows(
      client,
      'checkpoint_names',
      ['height', ...NAME_COLUMNS],
      snapshot.names.map((row) => ({ ...row, height: snapshot.height })),
    )
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
