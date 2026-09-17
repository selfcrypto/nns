/**
 * The database side of the indexer: load state on start, commit each batch.
 *
 * **One transaction per batch, and the cursor moves inside it.** State rows,
 * log lines and the cursor are written together or not at all, so a crash can
 * only lose a batch's work — never half-apply one. Recovery is then just
 * "resume at `next_batch`", with no reconciliation pass and nothing to repair.
 */

import { createHash } from 'node:crypto'

import { CONSTANTS, initialState, type Checkpoint, type NnsConfig, type NnsState } from '@nimiqnames/core'
import type { Pool, PoolClient } from 'pg'

import { checkpointRow, COMMITMENT_LAYOUT, hex, type CheckpointRow } from './checkpoint.js'
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

/**
 * Where this database's state came from (migration 009).
 *
 * A scratch database has no row: everything above `LAUNCH_HEIGHT` was derived
 * from the chain by this process, which is what {@link Store.loadVerification}
 * returning `null` means. A bootstrapped one has a row, and it is the only
 * place that records the range whose evidence is §8.4 Tier 1 rather than
 * Tier 3.
 */
export interface Verification {
  /** Lowest height derived from the chain. `LAUNCH_HEIGHT` once fully verified. */
  verifiedFrom: number
  /** Height the downloaded log was replayed through, or `null` for scratch. */
  bootstrapHeight: number | null
  /** The API root the log came from, or `null`. */
  bootstrapSource: string | null
  /** Bare lowercase hex — the §8.2 hash the peer's checkpoint committed. */
  bootstrapLogHash: string | null
  /** How far `hybrid`'s background re-derivation has reached, or `null`. */
  shadowThrough: number | null
  /**
   * The `SPEC_REVISION` a log rebuild ran under, and the height it replayed
   * through (migration `013`). `null` for a database never rebuilt from its
   * own log, and `null` again once the sweep has re-derived that range from
   * the chain and agreed with it.
   *
   * Not folded into `verifiedFrom`: over a rebuilt range the log's membership
   * *was* derived from the chain, under the previous revision's rules. Moving
   * `verifiedFrom` would under-claim that; saying nothing would over-claim it.
   */
  rebuiltRevision: number | null
  rebuiltThrough: number | null
}

const NAME_COLUMNS = ['name', 'owner', 'target', 'evm', 'expiry', 'status', 'host'] as const
const PENDING_COLUMNS = [
  'kind',
  'name',
  'effective_height',
  'new_owner',
  'seller',
  'price',
  'opened_height',
  'expiry_height',
  'fee_base',
  'commission_bp',
  'starting_price',
  'end_height',
  'bidder',
  'bid',
  'bid_ref_height',
  'bid_ref_tx_index',
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
  /**
   * Written in the same transaction as the rows it describes, which is the
   * only ordering that is safe: a database that records a bootstrap *after*
   * writing its rows can crash in between and come back claiming to be a
   * scratch replay of a log it downloaded. Under-claiming verification is
   * recoverable; over-claiming it is the failure this row exists to prevent.
   */
  verification?: Verification
}

/** One replayed segment, as {@link Store.rebuildFromLog} writes it. */
export interface RebuildSegment {
  /** The segment's entry state. `initialState()` on the first, so the diff emits every row. */
  readonly before: NnsState
  readonly after: NnsState
  readonly logRows: readonly LogRow[]
  readonly checkpoints: readonly Checkpoint[]
  readonly snapshot?: { readonly height: number; readonly names: readonly NameRow[] }
}

export interface RebuildInput {
  /** `CONSTANTS.SPEC_REVISION`, as declared by `--log-preserving`. */
  readonly revision: number
  /** The height the replay covers — the cursor's `scanned_through`. */
  readonly through: number
  /**
   * The row this database already had, carried through unchanged. A rebuild
   * says nothing new about where the state came from; it only adds what it
   * did to it.
   */
  readonly verification: Verification
  /** Drives the replay, calling `segment` once per segment, in order. */
  readonly replay: (segment: (segment: RebuildSegment) => Promise<void>) => Promise<void>
}

export interface RebuildOutcome {
  /** Log lines the replay produced — equal to the stored count, or it threw. */
  readonly lines: number
  /** How many of them came back with a different §7.4 token. */
  readonly verdictsRewritten: number
}

/**
 * Every table whose rows a rules rebuild re-derives.
 *
 * `log` is absent because it is the **input**, and `cursor` because where the
 * scan had got to is not a derived fact about the rules.
 */
const DERIVED_TABLES = [
  'checkpoint_names',
  'checkpoints',
  'settlements',
  'pending',
  'unreserved',
  'names',
  'params',
] as const

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
   * @param options `acrossLayouts` skips the §8.1 layout refusal — for
   *   {@link rebuildFromLog}, which is about to replace every checkpoint in
   *   the table and is the documented way out of the state that refusal
   *   describes. The **config fingerprint** check is not optional even there:
   *   a moved `LAUNCH_HEIGHT` or a new reserved name changes which messages
   *   belong in the log, and a rebuild replaying the log it already holds
   *   cannot discover that.
   * @throws {StoreError} if the stored config fingerprint disagrees with ours,
   *   or if a stored checkpoint was written at another §8.1 layout.
   */
  async loadCursor(options: { acrossLayouts?: boolean } = {}): Promise<Cursor | null> {
    const result = await this.pool.query<{
      next_batch: number
      scanned_through: number
      config_fingerprint: string
    }>('SELECT next_batch, scanned_through, config_fingerprint FROM "cursor" WHERE id')
    const row = result.rows[0]
    if (row === undefined) return null
    // The layout column labelled rows through four bumps and refused nothing:
    // a layout-5 database resumed under layout 6 writes layout-6 rows above
    // layout-5 ones, and `writeCheckpoints` only compares rows at one height.
    // Since 2026-09-11 it refuses here, where the fingerprint does — a
    // database at another layout is the output of a different function, and
    // the only correct continuation is none (migration 012).
    const stale = options.acrossLayouts === true ? undefined : await this.foreignLayout()
    if (stale !== undefined) {
      throw new StoreError(
        `this database holds checkpoints at §8.1 layout ${stale.layout} (latest at height ${stale.height}); ` +
          `this build derives layout ${COMMITMENT_LAYOUT}. No stored root is reproducible under the current ` +
          'rules, so continuing would stack two commitment functions in one table. ' +
          'Rebuild: `nns-vps rebuild <role> --from-log` replays this database\'s own §8.2 log under the new ' +
          'rules and keeps the registry up, if the revision is log-preserving; otherwise drop the database ' +
          'and bring the role back up (deploy/README.md).',
      )
    }
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
   * Where this database's state came from, or `null` for one replayed from
   * `LAUNCH_HEIGHT`.
   *
   * `null` is the answer for every database written before migration 009 as
   * well as every scratch database written since, and the two are the same
   * claim: nothing here came from anywhere but the chain.
   */
  async loadVerification(): Promise<Verification | null> {
    const result = await this.pool.query<{
      verified_from: number
      bootstrap_height: number | null
      bootstrap_source: string | null
      bootstrap_log_hash: Buffer | null
      shadow_through: number | null
      rebuilt_revision: number | null
      rebuilt_through: number | null
    }>(
      `SELECT verified_from, bootstrap_height, bootstrap_source, bootstrap_log_hash, shadow_through,
              rebuilt_revision, rebuilt_through
         FROM verification WHERE id`,
    )
    const row = result.rows[0]
    if (row === undefined) return null
    return {
      verifiedFrom: row.verified_from,
      bootstrapHeight: row.bootstrap_height,
      bootstrapSource: row.bootstrap_source,
      bootstrapLogHash: row.bootstrap_log_hash?.toString('hex') ?? null,
      shadowThrough: row.shadow_through,
      rebuiltRevision: row.rebuilt_revision,
      rebuiltThrough: row.rebuilt_through,
    }
  }

  /**
   * How far `hybrid`'s background re-derivation has got.
   *
   * Progress reporting, not a resume point — see migration 009. Written on a
   * throttle by the sweep rather than per batch: it is the one write in this
   * class that no root depends on, and putting an fsync in front of every
   * batch of a second full replay would cost more than the sweep it reports.
   */
  async recordShadowProgress(height: number): Promise<void> {
    await this.pool.query(
      'UPDATE verification SET shadow_through = $1, updated_at = now() WHERE id',
      [height],
    )
  }

  /**
   * The sweep reached the bootstrap height with every §8.1 commitment matching:
   * the range that arrived as a peer's log has now been derived from the chain,
   * and this database is §8.4 Tier 3 from `LAUNCH_HEIGHT` like any other.
   *
   * The bootstrap columns are kept rather than cleared. What the log said and
   * where it came from stays on the record — a verified bootstrap is a fact
   * about how this database was built, not an embarrassment to tidy away.
   */
  async completeVerification(launchHeight: number): Promise<void> {
    await this.pool.query(
      `UPDATE verification
          SET verified_from = $1, shadow_through = $2,
              rebuilt_revision = NULL, rebuilt_through = NULL, rebuilt_at = NULL,
              updated_at = now()
        WHERE id`,
      [launchHeight, launchHeight],
    )
    this.logger.info('verify.complete', { verifiedFrom: launchHeight })
  }

  /**
   * Reload state from the tables, or the empty state at `LAUNCH_HEIGHT` when
   * nothing has been written (§7.2 step 1).
   */
  async loadState(): Promise<NnsState> {
    const params = await this.pool.query<ParamsRow>(
      `SELECT fee_base, commission_bp, last_governance_height, state_height, next_due_height
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

  /** The newest checkpoint written at some other §8.1 layout, if there is one. */
  private async foreignLayout(): Promise<{ layout: number; height: number } | undefined> {
    const result = await this.pool.query<{ layout: number; height: number }>(
      'SELECT layout, height FROM checkpoints WHERE layout <> $1 ORDER BY height DESC LIMIT 1',
      [COMMITMENT_LAYOUT],
    )
    return result.rows[0]
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
      if (input.verification !== undefined) await writeVerification(client, input.verification)
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
   * Replace every derived row from a replay of this database's own `log`, in
   * **one transaction** (`tasks/14` D2, migration `013`).
   *
   * Three properties, and each is a choice:
   *
   * - **`DELETE`, never `TRUNCATE`.** `TRUNCATE` takes an `ACCESS EXCLUSIVE`
   *   lock, which blocks the API's reads until this commits; `DELETE` takes a
   *   row lock and readers keep their snapshot. That is the whole reason the
   *   registry stays up through a rebuild where today it goes down for the
   *   length of a resync.
   * - **One transaction for the whole rebuild**, so a reader sees the state
   *   before it or the state after it and never a half-replayed registry. The
   *   memory bound is the replay's, not this method's: segments arrive one at
   *   a time and are written as they come.
   * - **The cursor is not touched.** The rebuild re-derives what the scan
   *   already discovered; where the scan had got to is unchanged by that, and
   *   rewriting it would restart a tail that has no reason to move.
   *
   * The `log` itself is **rewritten, not replaced**: its verdict column is the
   * only thing a rules rebuild can change, so every produced line is matched
   * against the stored one at the same `(block_height, tx_index)` and only the
   * token moves. A produced line with no stored counterpart, a stored line the
   * replay never produced, or a difference in any other field means the
   * revision was **not** log-preserving after all — the declaration was wrong,
   * and the transaction rolls back naming the line. That check is what makes
   * `--log-preserving` an assertion rather than a promise.
   */
  async rebuildFromLog(input: RebuildInput): Promise<RebuildOutcome> {
    return await withTransaction(this.pool, async (client) => {
      const stored = await readLogIndex(client)
      const storedLines = stored.size

      // Derived tables only. `log` is rewritten in place below and `cursor`
      // is left exactly as it was.
      for (const table of DERIVED_TABLES) await client.query(`DELETE FROM ${table}`)

      let rewritten = 0
      let produced = 0
      await input.replay(async (segment) => {
        const diff = diffState(segment.before, segment.after)
        if (diff.hasRowChanges) await this.writeDiff(client, diff)
        await this.writeParams(client, diff.params)
        rewritten += await rewriteLogVerdicts(client, segment.logRows, stored)
        produced += segment.logRows.length
        await this.writeCheckpoints(client, segment.checkpoints)
        if (segment.snapshot !== undefined) await this.writeSnapshot(client, segment.snapshot)
      })

      // Whatever is left in the index is a line this replay did not produce.
      const orphan = stored.keys().next()
      if (orphan.done !== true) {
        throw new StoreError(
          `the replay did not reproduce the log line at ${orphan.value} (${stored.size} of ${storedLines} ` +
            'unreproduced). A rules rebuild replays the log it already holds, so every stored line must come ' +
            'back out of it — this revision changes which messages are logged and is therefore not ' +
            'log-preserving. Nothing has been written; rebuild from the chain.',
        )
      }

      await writeVerification(client, {
        ...input.verification,
        rebuiltRevision: input.revision,
        rebuiltThrough: input.through,
      })
      return { lines: produced, verdictsRewritten: rewritten }
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
      `INSERT INTO params (id, fee_base, commission_bp,
                           last_governance_height, state_height, next_due_height)
       VALUES (TRUE, $1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE
         SET fee_base = EXCLUDED.fee_base,
             commission_bp = EXCLUDED.commission_bp,
             last_governance_height = EXCLUDED.last_governance_height,
             state_height = EXCLUDED.state_height,
             next_due_height = EXCLUDED.next_due_height`,
      [
        params.fee_base,
        params.commission_bp,
        params.last_governance_height,
        params.state_height,
        params.next_due_height,
      ],
    )
  }
}

/**
 * The stored log, as `(block_height:tx_index) → line`, split at its verdict.
 *
 * The log is small by design (§8.2: under 15 MB at 100,000 messages), which is
 * a property of the protocol's incentives rather than of this query — so it is
 * read in the same keyset-paginated chunks {@link Store.streamLogRows} uses,
 * and held as two strings per line rather than as a row object.
 */
async function readLogIndex(client: PoolClient): Promise<Map<string, StoredLine>> {
  const index = new Map<string, StoredLine>()
  let after: readonly [number, number] = [-1, -1]
  for (;;) {
    const page = await client.query<LogRow>(
      `SELECT ${LOG_COLUMNS.join(', ')} FROM log
       WHERE (block_height, tx_index) > ($1::bigint, $2::int)
       ORDER BY block_height, tx_index
       LIMIT 10000`,
      [after[0], after[1]],
    )
    for (const row of page.rows) {
      index.set(`${row.block_height}:${row.tx_index}`, {
        fields: `${row.tx_hash} ${row.sender} ${row.recipient} ${row.value} ${row.data}`,
        verdict: row.verdict,
      })
    }
    const last = page.rows[page.rows.length - 1]
    if (last === undefined || page.rows.length < 10_000) return index
    after = [last.block_height, last.tx_index]
  }
}

interface StoredLine {
  /** Everything a rules rebuild must **not** move: §8.2's line minus its token. */
  readonly fields: string
  readonly verdict: string
}

/**
 * Move the verdicts a rules rebuild changed, and refuse everything else.
 *
 * Each produced line must match a stored one at the same canonical position in
 * every field but the token. Matched lines leave the index; what remains when
 * the replay ends is a line the replay never produced, which
 * {@link Store.rebuildFromLog} reports.
 *
 * @returns how many verdicts moved.
 */
async function rewriteLogVerdicts(
  client: PoolClient,
  rows: readonly LogRow[],
  stored: Map<string, StoredLine>,
): Promise<number> {
  const heights: number[] = []
  const indexes: number[] = []
  const verdicts: string[] = []
  for (const row of rows) {
    const key = `${row.block_height}:${row.tx_index}`
    const was = stored.get(key)
    if (was === undefined) {
      // Not reachable from a rules change: the candidates *are* the stored
      // lines, one produced line each at its own key, so a key with no stored
      // counterpart means the replay invented a position. Kept as the
      // invariant it is, because the alternative to noticing is a log whose
      // §8.2 hash nothing can reproduce.
      throw new StoreError(
        `the replay produced a log line at ${key}, which is not a position in the log it was replaying. ` +
          'The candidates come from the stored lines, so this is a defect in the replay, not a rules change.',
      )
    }
    const fields = `${row.tx_hash} ${row.sender} ${row.recipient} ${row.value} ${row.data}`
    if (fields !== was.fields) {
      throw new StoreError(
        `the replay rewrote a stored field of the log line at ${key}:\n  stored: ${was.fields}\n  replay: ${fields}\n` +
          'Only the §7.4 token may move in a rules rebuild. A canonical form, an attributed sender (§7.2) or a ' +
          'rank (§5.2) that moves needs the chain, not this log. Nothing has been written.',
      )
    }
    stored.delete(key)
    if (was.verdict === row.verdict) continue
    heights.push(row.block_height)
    indexes.push(row.tx_index)
    verdicts.push(row.verdict)
  }
  if (heights.length === 0) return 0
  await client.query(
    `UPDATE log SET verdict = moved.verdict
       FROM (SELECT * FROM unnest($1::bigint[], $2::int[], $3::text[]))
            AS moved(block_height, tx_index, verdict)
      WHERE log.block_height = moved.block_height AND log.tx_index = moved.tx_index`,
    [heights, indexes, verdicts],
  )
  return heights.length
}

/**
 * Upsert the single `verification` row (migration 009).
 *
 * A free function rather than a method because it runs inside
 * {@link Store.commitBatch}'s transaction, on that transaction's client — the
 * point of writing it here at all.
 */
async function writeVerification(client: PoolClient, verification: Verification): Promise<void> {
  await client.query(
    `INSERT INTO verification
       (id, verified_from, bootstrap_height, bootstrap_source, bootstrap_log_hash, shadow_through,
        rebuilt_revision, rebuilt_through, rebuilt_at, updated_at)
     VALUES (TRUE, $1, $2, $3, $4, $5, $6, $7, CASE WHEN $6::int IS NULL THEN NULL ELSE now() END, now())
     ON CONFLICT (id) DO UPDATE
       SET verified_from = EXCLUDED.verified_from,
           bootstrap_height = EXCLUDED.bootstrap_height,
           bootstrap_source = EXCLUDED.bootstrap_source,
           bootstrap_log_hash = EXCLUDED.bootstrap_log_hash,
           shadow_through = EXCLUDED.shadow_through,
           rebuilt_revision = EXCLUDED.rebuilt_revision,
           rebuilt_through = EXCLUDED.rebuilt_through,
           rebuilt_at = EXCLUDED.rebuilt_at,
           updated_at = now()`,
    [
      verification.verifiedFrom,
      verification.bootstrapHeight,
      verification.bootstrapSource,
      verification.bootstrapLogHash === null ? null : Buffer.from(verification.bootstrapLogHash, 'hex'),
      verification.shadowThrough,
      verification.rebuiltRevision,
      verification.rebuiltThrough,
    ],
  )
}
