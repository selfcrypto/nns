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

import { BURN_ADDRESS, CONSTANTS, merkleRoot, parseAddress, type Address, type Auction, type NameStatus } from '@nns/core'
import { logLineFromRow, toHeight, toLuna, type LogRow } from '@nns/indexer'
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
  /** §6 `E` record — lowercase `0x`-hex, `''` when unset. */
  readonly evm: string
  readonly expiry: number
  readonly status: NameStatus
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
}

/**
 * An open `A` from the pending set (§6 `A`, r28) — `core`'s `Auction`
 * itself, so `core.requiredBid` can be applied to it unchanged. `bidder` is
 * `null` with `bid` 0 and `bidRef` null until the first bid stands. The ref
 * is settlement identity: not committed (§8.1), but it is what the close's
 * two legs and an outbid refund are keyed by, so a bidder can find their
 * own money in `/settlements`.
 */
export type ApiAuction = Auction

/*
 * `ApiPendingUnreserve` lived here through r21, and `NameDetail` carried an
 * `unreserve` field beside it. r22 made a `U` execute in the block it lands in
 * (§6 `U`), so there is no pending form to report — what a caller can still ask
 * about a `U` is `unreserved`, below, which says whether one has fired.
 */

/** Everything the state knows about one name. */
export interface NameDetail {
  readonly record: ApiNameRecord | null
  readonly transfer: ApiPendingTransfer | null
  readonly offer: ApiOffer | null
  /** Never set beside `offer`: an auction and an offer do not coexist (§6 `A`). */
  readonly auction: ApiAuction | null
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
  readonly verification: VerificationSnapshot
}

/**
 * How much of what this resolver serves it derived from the chain itself
 * (indexer migration 009, `NNS_START_MODE`).
 *
 * §8.4 grades verification in tiers and §8.5 makes a client's depth indicator
 * a **neutral** disclosure rather than a warning. This is the server half of
 * that: an indexer seeded from a peer's log holds Tier 1 evidence for the
 * bootstrapped range — strong, but blind to a message that was on chain and
 * omitted from the log — and a caller cannot tell unless it is told.
 *
 * `verifiedFrom` equals `LAUNCH_HEIGHT` and `bootstrap` is `null` for every
 * indexer replayed from the chain, which is every indexer that predates the
 * mode and every one still using the default.
 */
export interface VerificationSnapshot {
  /** The lowest height this resolver derived from the chain itself. */
  readonly verifiedFrom: number
  readonly bootstrap: {
    /** Height the downloaded log was replayed through. */
    readonly height: number
    /** The API root it was downloaded from. */
    readonly source: string
    /** How far a background re-derivation has reached, or `null` if none runs. */
    readonly verifiedThrough: number | null
  } | null
}

/** A stored §8.1 checkpoint row, digests as bare lowercase hex. */
export interface LatestCheckpoint {
  readonly height: number
  readonly layout: number
  readonly nameRoot: string
  readonly pricesRoot: string
  readonly pendingRoot: string
  /** `null` on a layout `1` row, whose commitment function had no such digest. */
  readonly unreservedRoot: string | null
  readonly logHash: string
  readonly commitment: string
}

/**
 * What §8.3 proofs derive from: the latest checkpoint and the name records
 * at its height (migration `005` in the indexer).
 *
 * `records` is `null` when the snapshot cannot back the checkpoint — the
 * table is stale or missing, or the §8.1 root derived from it disagrees with
 * `checkpoints.name_root`. Either way the API degrades to "no proof", never
 * to a proof that fails verification.
 */
export interface ProofBase {
  readonly checkpoint: LatestCheckpoint
  readonly records: ReadonlyMap<string, ApiNameRecord> | null
}

/**
 * A lookup of one checkpoint by height, carrying enough to explain a miss.
 *
 * Three different failures hide behind "no row at this height" and a client
 * needs to tell them apart: not reached yet (wait), not retained (ask someone
 * else), or a gap in the middle (this database is damaged). `retained` is the
 * range that lets the route decide, and it is read **only on a miss** — the
 * hit path stays one query.
 */
export interface CheckpointLookup {
  readonly checkpoint: LatestCheckpoint | null
  /**
   * Oldest and newest retained checkpoint heights. `null` when the row was
   * found — nothing needed explaining — or when the table is empty.
   */
  readonly retained: { readonly oldest: number; readonly newest: number } | null
}

/** The §8.2 log through the latest checkpoint — the hash-covered prefix. */
export interface CheckpointLog {
  readonly checkpointHeight: number
  readonly logHash: string
  readonly lines: readonly string[]
}

/** One outstanding obligation (§6 `M`, §7.4), keyed by the owing transaction. */
export interface ApiObligation {
  readonly refHeight: number
  readonly refTxIndex: number
  readonly ordinal: number
  readonly kind: string
  readonly owedBy: Address
  readonly owedTo: Address
  readonly amount: bigint
}

/** A log line addressed to `BURN_ADDRESS` — an `F` attestation, or junk that forfeited (§6 `F`). */
export interface BurnAttestation {
  readonly height: number
  readonly txIndex: number
  readonly txHash: string
  readonly sender: Address
  readonly value: bigint
  readonly verdict: string
}

/**
 * Both halves of §10.2's identity, read from one snapshot so they cannot
 * describe two different instants: the attestations (whose `OK` values sum to
 * *burned*) and the treasury's net revenue (whose `BURN_SHARE` is *owed*).
 * Until 2026-08-17 only the attestations were served, which made §10.2's
 * "burned-versus-owed is computable from the log" a promise with no computer
 * — an outsider could see what was burned and had nothing to compare it
 * against.
 */
export interface BurnReport {
  readonly attestations: readonly BurnAttestation[]
  /**
   * §10.2's burn base as **r24 defines it**: Σ value of `OK`-verdict lines
   * whose recipient is `TREASURY_ADDRESS` and whose type is `G`, `N`, `O` or
   * `M` — accepted registrations, renewals, listing fees, and marketplace
   * commission (an `M` *to* the treasury is a commission by construction;
   * refunds run the other way).
   *
   * The base is defined over the log, never read off the balance: the
   * balance also holds stray dust (an `S`/`X` may name the treasury as
   * counterparty), refund-class money in flight toward its `M`, forfeited
   * junk, and wrongly-sent amounts — none of it revenue. Review caught the
   * first cut of this comment citing §10.2's "the treasury's balance *is*
   * its revenue" as if it were the definition; r24 amended the section to
   * state the log-computable base normatively and demote that sentence to
   * the approximation it always was.
   */
  readonly revenue: bigint
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
  auctions(): Promise<Snapshot<readonly ApiAuction[]>>
  params(): Promise<Snapshot<ParamsSnapshot>>
  /** `null` while no checkpoint exists yet. */
  latestCheckpoint(): Promise<Snapshot<LatestCheckpoint | null>>
  /** One checkpoint by exact height, with the retained range when it is absent. */
  checkpointAt(height: number): Promise<Snapshot<CheckpointLookup>>
  /** `null` while no checkpoint exists yet; see {@link ProofBase} for degraded forms. */
  proofBase(): Promise<Snapshot<ProofBase | null>>
  /** `null` while no checkpoint exists yet. */
  logThroughCheckpoint(): Promise<Snapshot<CheckpointLog | null>>
  outstanding(owedTo: Address | null): Promise<Snapshot<readonly ApiObligation[]>>
  burn(): Promise<Snapshot<BurnReport>>
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
    evm: text(row, 'evm'),
    expiry: toHeight(row['expiry'], 'expiry'),
    status: status(row),
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

/**
 * Migration 010's row. The shape check refuses a half-present bid, so a
 * non-null `bidder` here always comes with its ref — but this reader still
 * checks, because a row read is not a row written.
 */
function auction(row: Row): ApiAuction {
  const bidder = nullableAddress(row, 'bidder')
  const refHeight = row['bid_ref_height']
  const refIndex = row['bid_ref_tx_index']
  if (bidder !== null && (refHeight === null || refIndex === null)) {
    throw new QueryError(`pending: AUCTION row for ${JSON.stringify(row['name'])} has a bidder but no bid ref`)
  }
  return {
    name: text(row, 'name'),
    seller: address(row, 'seller'),
    startingPrice: toLuna(row['starting_price'], 'starting_price'),
    endHeight: toHeight(row['end_height'], 'end_height'),
    bidder,
    bid: toLuna(row['bid'], 'bid'),
    bidRef:
      bidder === null
        ? null
        : { height: toHeight(refHeight, 'bid_ref_height'), txIndex: toHeight(refIndex, 'bid_ref_tx_index') },
  }
}

const NAME_COLUMNS = 'name, owner, target, evm, expiry, status, host'

const AUCTION_COLUMNS = 'name, seller, starting_price, end_height, bidder, bid, bid_ref_height, bid_ref_tx_index'

const CHECKPOINT_COLUMNS =
  'height, layout, name_root, prices_root, pending_root, unreserved_root, log_hash, commitment'

function bytesHex(row: Row, field: string): string {
  const value = row[field]
  if (!(value instanceof Buffer)) throw new QueryError(`${field}: expected bytes, got ${JSON.stringify(value)}`)
  return value.toString('hex')
}

function latestCheckpointOf(row: Row): LatestCheckpoint {
  return {
    height: toHeight(row['height'], 'height'),
    layout: toHeight(row['layout'], 'layout'),
    nameRoot: bytesHex(row, 'name_root'),
    pricesRoot: bytesHex(row, 'prices_root'),
    pendingRoot: bytesHex(row, 'pending_root'),
    unreservedRoot: row['unreserved_root'] === null ? null : bytesHex(row, 'unreserved_root'),
    logHash: bytesHex(row, 'log_hash'),
    commitment: bytesHex(row, 'commitment'),
  }
}

// ── Postgres implementation ─────────────────────────────────────────────────

const UNDEFINED_TABLE = '42P01'

export class PgQueries implements Queries {
  readonly #pool: Pool
  /**
   * The checkpoint tree, rebuilt only when the checkpoint moves. Keyed on
   * `height:name_root` so a divergent rewrite at the same height — which
   * `Store.writeCheckpoints` refuses anyway — could never serve a stale tree.
   * A cache of a projection: worst case is one wasted rebuild, never a wrong
   * answer, because the derived root is compared to the stored one below.
   */
  #tree: { key: string; records: ReadonlyMap<string, ApiNameRecord> | null } | null = null

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
        `SELECT kind, effective_height, new_owner,
                seller, price, opened_height, expiry_height,
                starting_price, end_height, bidder, bid, bid_ref_height, bid_ref_tx_index
           FROM pending WHERE name = $1`,
        [name],
      )
      const unreserved = await client.query('SELECT 1 FROM unreserved WHERE name = $1', [name])

      const record: Row | undefined = names.rows[0]
      let transfer: ApiPendingTransfer | null = null
      let openOffer: ApiOffer | null = null
      let openAuction: ApiAuction | null = null

      for (const row of pending.rows as Row[]) {
        switch (text(row, 'kind')) {
          case 'TRANSFER':
            transfer = {
              newOwner: address(row, 'new_owner'),
              effectiveHeight: toHeight(row['effective_height'], 'effective_height'),
            }
            break
          case 'OFFER':
            openOffer = offer({ ...row, name })
            break
          // 'UNRESERVE' falls through to the default deliberately. r22 removed
          // the pending `U` and migration 007 removed the kind, so a surviving
          // row means a pre-r22 database being read by a post-r22 API — which
          // must throw rather than answer from a shape neither side agrees on.
          case 'GOVERNANCE':
            // Keyed on the empty name, so no §4.1-valid name can match it —
            // but this query must not rely on the caller having validated.
            break
          case 'AUCTION':
            openAuction = auction({ ...row, name })
            break
          default:
            throw new QueryError(`pending row of unknown kind ${JSON.stringify(row['kind'])}`)
        }
      }

      return {
        record: record === undefined ? null : nameRecord(record),
        transfer,
        offer: openOffer,
        auction: openAuction,
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

  async auctions(): Promise<Snapshot<readonly ApiAuction[]>> {
    return this.#snapshot(async (client) => {
      const result = await client.query(
        `SELECT ${AUCTION_COLUMNS} FROM pending WHERE kind = 'AUCTION' ORDER BY name`,
      )
      return (result.rows as Row[]).map(auction)
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
      const verification = await client.query(
        `SELECT verified_from, bootstrap_height, bootstrap_source, shadow_through
           FROM verification WHERE id`,
      )
      // #snapshot has already proven the params row exists.
      const row = params.rows[0] as Row
      const scheduled: Row | undefined = governance.rows[0]
      const seeded: Row | undefined = verification.rows[0]
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
        verification: verificationOf(seeded),
      }
    })
  }

  async latestCheckpoint(): Promise<Snapshot<LatestCheckpoint | null>> {
    return this.#snapshot(async (client) => {
      const row = await latestCheckpointRow(client)
      return row === null ? null : latestCheckpointOf(row)
    })
  }

  /**
   * One checkpoint by exact height.
   *
   * The bounds query runs **only when the row is missing**. On a hit it would
   * be two full-table aggregates bought for nothing; on a miss it is the
   * difference between "come back later" and "this server cannot serve you",
   * which are different instructions to the caller.
   */
  async checkpointAt(height: number): Promise<Snapshot<CheckpointLookup>> {
    return this.#snapshot(async (client) => {
      const result = await client.query(
        `SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints WHERE height = $1`,
        [height],
      )
      const row = result.rows[0] as Row | undefined
      if (row !== undefined) return { checkpoint: latestCheckpointOf(row), retained: null }

      // Sequential, like `detail` — a pg client cannot run queries
      // concurrently, and issuing them anyway relies on deprecated queueing.
      const bounds = await client.query(
        'SELECT min(height) AS oldest, max(height) AS newest FROM checkpoints',
      )
      const b = bounds.rows[0] as Row | undefined
      if (b === undefined || b['oldest'] === null || b['newest'] === null) {
        return { checkpoint: null, retained: null }
      }
      return {
        checkpoint: null,
        retained: { oldest: toHeight(b['oldest'], 'oldest'), newest: toHeight(b['newest'], 'newest') },
      }
    })
  }

  async proofBase(): Promise<Snapshot<ProofBase | null>> {
    return this.#snapshot(async (client) => {
      const row = await latestCheckpointRow(client)
      if (row === null) return null
      const checkpoint = latestCheckpointOf(row)

      const key = `${checkpoint.height}:${checkpoint.nameRoot}`
      if (this.#tree?.key !== key) {
        this.#tree = { key, records: await loadTree(client, checkpoint) }
      }
      return { checkpoint, records: this.#tree.records }
    })
  }

  async logThroughCheckpoint(): Promise<Snapshot<CheckpointLog | null>> {
    return this.#snapshot(async (client) => {
      const row = await latestCheckpointRow(client)
      if (row === null) return null
      const checkpoint = latestCheckpointOf(row)

      // Keyset-paginated like the indexer's own seed read: the log is small
      // by design (§8.2), but one unbounded SELECT would bet on that.
      const lines: string[] = []
      let after: readonly [number, number] = [-1, -1]
      for (;;) {
        const page = await client.query(
          `SELECT block_height, tx_index, tx_hash, sender, recipient, value, data, verdict
             FROM log
            WHERE block_height <= $1 AND (block_height, tx_index) > ($2::bigint, $3::int)
            ORDER BY block_height, tx_index
            LIMIT 10000`,
          [checkpoint.height, after[0], after[1]],
        )
        for (const raw of page.rows as LogRow[]) lines.push(logLineFromRow(raw))
        const last = page.rows[page.rows.length - 1] as LogRow | undefined
        if (last === undefined || page.rows.length < 10_000) break
        after = [last.block_height, last.tx_index]
      }
      return { checkpointHeight: checkpoint.height, logHash: checkpoint.logHash, lines }
    })
  }

  async outstanding(owedTo: Address | null): Promise<Snapshot<readonly ApiObligation[]>> {
    return this.#snapshot(async (client) => {
      const filter = owedTo === null ? '' : ' WHERE owed_to = $1'
      const result = await client.query(
        `SELECT ref_height, ref_tx_index, ordinal, kind, owed_by, owed_to, amount
           FROM settlements${filter}
          ORDER BY ref_height, ref_tx_index, ordinal`,
        owedTo === null ? [] : [owedTo],
      )
      return (result.rows as Row[]).map((row) => ({
        refHeight: toHeight(row['ref_height'], 'ref_height'),
        refTxIndex: toHeight(row['ref_tx_index'], 'ref_tx_index'),
        ordinal: toHeight(row['ordinal'], 'ordinal'),
        kind: text(row, 'kind'),
        owedBy: address(row, 'owed_by'),
        owedTo: address(row, 'owed_to'),
        amount: toLuna(row['amount'], 'amount'),
      }))
    })
  }

  async burn(): Promise<Snapshot<BurnReport>> {
    return this.#snapshot(async (client) => {
      // Only tagged transfers enter the log (§6 `F`) — an untagged burn is
      // exactly the shortfall the dashboard exists to make visible.
      //
      // Filtering by recipient alone is not enough, and the 2026-08-14 battery
      // proved it: an `S` pointing a name at `BURN_ADDRESS` (a legitimate way
      // to say "this name resolves nowhere") and a `U` awarding to it (which
      // the reducer rejects, `INVALID_RECIPIENT`) both carry `DUST_VALUE` to
      // that address and both appeared here as burn attestations. So the type
      // tag is part of the filter: `NNS1F` is 4e4e533146 in the hex the log
      // stores, and the recipient check stays because an `F` aimed anywhere
      // else burned nothing.
      const result = await client.query(
        `SELECT block_height, tx_index, tx_hash, sender, value, verdict
           FROM log WHERE recipient = $1 AND data LIKE '4e4e533146%'
          ORDER BY block_height, tx_index`,
        [BURN_ADDRESS],
      )
      const attestations = (result.rows as Row[]).map((row) => ({
        height: toHeight(row['block_height'], 'block_height'),
        txIndex: toHeight(row['tx_index'], 'tx_index'),
        txHash: text(row, 'tx_hash'),
        sender: address(row, 'sender'),
        value: toLuna(row['value'], 'value'),
        verdict: text(row, 'verdict'),
      }))

      // The owed half's base (see BurnReport): §10.2's burn base as r24 pins
      // it — accepted revenue, the four prefixes being `NNS1G` / `NNS1N` /
      // `NNS1O` / `NNS1M` in the lowercase hex the log stores. Same
      // transaction as above, so both halves describe one instant. COALESCE,
      // because SUM over zero rows is NULL and a fresh registry owes
      // nothing, not an error.
      const revenue = await client.query(
        `SELECT COALESCE(SUM(value), 0) AS revenue
           FROM log WHERE recipient = $1 AND verdict = 'OK'
            AND (data LIKE '4e4e533147%' OR data LIKE '4e4e53314e%'
              OR data LIKE '4e4e53314f%' OR data LIKE '4e4e53314d%')`,
        [CONSTANTS.TREASURY_ADDRESS],
      )
      const row = (revenue.rows as Row[])[0]
      return { attestations, revenue: toLuna(row?.['revenue'], 'revenue') }
    })
  }
}

/**
 * The `verification` row as served, or the scratch answer when there is none.
 *
 * No row means one thing and it is the strong answer: everything above
 * `LAUNCH_HEIGHT` here was derived from the chain by the indexer that wrote it.
 * Reporting that as `null` would make the default look like missing
 * information, which is the opposite of what it is.
 */
function verificationOf(row: Row | undefined): VerificationSnapshot {
  if (row === undefined) return { verifiedFrom: CONSTANTS.LAUNCH_HEIGHT, bootstrap: null }
  const height = row['bootstrap_height']
  const source = row['bootstrap_source']
  return {
    verifiedFrom: toHeight(row['verified_from'], 'verified_from'),
    bootstrap:
      height === null || height === undefined || typeof source !== 'string'
        ? null
        : {
            height: toHeight(height, 'bootstrap_height'),
            source,
            verifiedThrough:
              row['shadow_through'] === null || row['shadow_through'] === undefined
                ? null
                : toHeight(row['shadow_through'], 'shadow_through'),
          },
  }
}

async function latestCheckpointRow(client: PoolClient): Promise<Row | null> {
  const result = await client.query(
    `SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints ORDER BY height DESC LIMIT 1`,
  )
  return (result.rows[0] as Row | undefined) ?? null
}

/**
 * The checkpoint's name records, or `null` when they cannot back it.
 *
 * The §8.1 root is re-derived from the loaded rows and compared to the
 * stored `name_root` — this is what lets a full-table snapshot be trusted
 * without trusting the write path: a stale, torn or missing snapshot (or an
 * indexer that predates migration `005`) degrades to "no proof", never to a
 * proof that will not verify. An empty table backs an empty tree, whose
 * root really is 32 zero bytes.
 */
async function loadTree(
  client: PoolClient,
  checkpoint: LatestCheckpoint,
): Promise<ReadonlyMap<string, ApiNameRecord> | null> {
  // Probed rather than queried outright: an indexer that predates migration
  // `005` has no such table, and the error would abort the surrounding
  // transaction — turning "no proofs yet" into a 503 for resolution itself.
  const probe = await client.query(`SELECT to_regclass('checkpoint_names') AS t`)
  if ((probe.rows[0] as Row | undefined)?.['t'] === null) return null

  const result = await client.query(
    `SELECT height, ${NAME_COLUMNS} FROM checkpoint_names`,
  )
  const records = new Map<string, ApiNameRecord>()
  for (const raw of result.rows as Row[]) {
    if (toHeight(raw['height'], 'height') !== checkpoint.height) return null
    const record = nameRecord(raw)
    records.set(record.name, record)
  }
  const derived = Buffer.from(merkleRoot({ names: records })).toString('hex')
  return derived === checkpoint.nameRoot ? records : null
}

function isUndefinedTable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNDEFINED_TABLE
  )
}
