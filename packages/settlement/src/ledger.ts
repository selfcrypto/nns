/**
 * The idempotent ledger: what has been paid, what is in flight, and what a
 * crash costs at every point in between.
 *
 * **This file holds no key and broadcasts nothing.** It is the memory the
 * issuer will pin its decisions in; issuing is the next deliverable. Everything
 * here is either a pure derivation over a verified {@link WatchSnapshot} or a
 * write to this service's own database.
 *
 * ## The key, and why it is the transaction that owes rather than the one that pays
 *
 * `(ref, kind)` — `<height>:<txIndex>:<KIND>`, `obligationKey` in `watch.ts` —
 * is the primary key of `obligations` and the identity of every payment. It is
 * the `(height, tx_index)` an `M` payload names (§6 `M`), and it is stable
 * against everything that could otherwise create a second debt: a restart, a
 * re-read of the whole log from height zero, two processes reading the same
 * checkpoint, or a crash between deciding and sending. All of them re-derive
 * the same key from the same log line and collide with the row already here.
 *
 * Keying by the `M` instead would invert that: an `M` signed but never landed
 * has no identity the log can confirm, so every crash would look like a fresh
 * debt.
 *
 * ## The state machine, and what a crash costs in each state
 *
 * An obligation moves DUE → CLAIMED → BROADCAST → CONFIRMED, and may fall back
 * from CLAIMED or BROADCAST to DUE exactly once per proven-dead attempt.
 *
 * | State | Means | A crash here costs |
 * |---|---|---|
 * | `DUE` | The log says outstanding; no attempt is live | Nothing. The due set is a fact about the log and is re-derived on the next poll |
 * | `CLAIMED` | A transaction plan is committed. Signed? Sent? **Unknown** | Nothing in money, one stall. Recovery re-sends *these exact bytes*, which the network collapses to one transaction |
 * | `BROADCAST` | A node returned this transaction's hash | Nothing. A node's acceptance is not landing (§5.3 fails by silence), so the recovery is the same as CLAIMED: wait for the log, re-send after expiry |
 * | `CONFIRMED` | The leg stopped being outstanding in the log at or below a stamped checkpoint height | Nothing. Terminal, and re-derivable from the log by anyone |
 *
 * **CLAIMED is the only ambiguous state, and it is ambiguous by construction.**
 * There is no way to commit a database row and hand a transaction to a node
 * atomically, so the window exists in any design; what a design chooses is what
 * the window costs. Here it costs nothing, because the plan is pinned *before*
 * the send and re-used verbatim after a crash: identical re-broadcasts share one
 * transaction hash and land at most once (`docs/rpc-reference.md` §4). The
 * field that makes or breaks that is `validity_start_height` — recompute it
 * from the node's head on restart and the retry is a *different* transaction,
 * with a different hash, and both are valid. That is the double payment this
 * ledger exists to prevent, and it is a stored column rather than a derived
 * one for exactly that reason.
 *
 * There is deliberately no state between "chosen to settle" and CLAIMED: the
 * committed plan *is* the choice. A crash while the issuer is still deciding
 * leaves a DUE row, which costs nothing.
 *
 * ## How a payment is confirmed, and how one is declared dead
 *
 * Confirmed means: **the leg is no longer outstanding in a verified log at or
 * below a stamped checkpoint height.** Never "N blocks have passed", never a
 * receipt from the node. §7.2 step 3 forbids an indexer from advancing past the
 * last finalised macro block, so any stamped height is already final and
 * `/log` is served through a checkpoint boundary on top of that — the rule is
 * inherited from the source, and this package expresses none of it.
 *
 * The mirror image is the only rule that lets a pinned transaction be replaced.
 * An attempt is dead when a stamped checkpoint height **above** its
 * `expires_after` still shows the leg outstanding: past its validity window it
 * can never land, and the log says it never did. Both halves come from the same
 * snapshot, so the ledger reads no node to decide either.
 */

import { formatAddress, parseAddress, refKey, type Address, type NnsConfig, type TxRef } from '@nimiqnames/core'
import { configFingerprint, toLuna, type Logger } from '@nns/indexer'

import { obligationKey, type DueObligation, type LedgerKind, type WatchSnapshot } from './watch.js'
import { migrateLedger, withTransaction, type Pool } from './db.js'
import type { PoolClient } from 'pg'

export class LedgerError extends Error {
  override readonly name = 'LedgerError'
}

export type ObligationState = 'DUE' | 'CLAIMED' | 'BROADCAST' | 'CONFIRMED'
export type AttemptState = 'PINNED' | 'SENT' | 'CONFIRMED' | 'EXPIRED'

/** The transaction fields of a live attempt, exactly as they will be signed. */
export interface LiveAttempt {
  readonly attemptNo: number
  readonly state: 'PINNED' | 'SENT'
  readonly sender: Address
  readonly recipient: Address
  readonly value: bigint
  readonly fee: bigint
  /** Hex, as the RPC requires and as `core`'s builders return it. */
  readonly data: string
  readonly validityStartHeight: number
  /** Last height at which this transaction can still land. Supplied, not derived. */
  readonly expiresAfter: number
  readonly txHash: string | null
}

/** One obligation as the ledger holds it, with its live attempt if it has one. */
export interface LedgerEntry {
  readonly key: string
  readonly ref: TxRef
  readonly kind: LedgerKind
  readonly owedBy: Address
  readonly owedTo: Address
  readonly amount: bigint
  readonly state: ObligationState
  readonly firstSeenHeight: number
  readonly confirmedHeight: number | null
  readonly attemptCount: number
  readonly live: LiveAttempt | null
}

/** The ledger's memory of which log it is paying against. */
export interface StoredSource {
  readonly apiUrl: string
  readonly configFingerprint: string
  readonly checkpointHeight: number
  readonly logHash: string
}

/** A leg observed discharged, and by whose transaction if by ours at all. */
export interface ConfirmedLeg {
  readonly key: string
  readonly ref: TxRef
  readonly kind: LedgerKind
  readonly confirmedHeight: number
  /** The attempt that paid it, or `null` — nobody here sent one. */
  readonly attemptNo: number | null
}

/** A pinned transaction proven dead: past its window, still owed. */
export interface DeadAttempt {
  readonly key: string
  readonly ref: TxRef
  readonly kind: LedgerKind
  readonly attemptNo: number
  readonly expiresAfter: number
  readonly txHash: string | null
  /** SENT means a node took it and it still never landed — worth an operator's attention. */
  readonly wasSent: boolean
}

/** What one snapshot changed. Returned so a caller can log or alert on it. */
export interface LedgerUpdate {
  readonly checkpointHeight: number
  readonly logHash: string
  readonly inserted: readonly DueObligation[]
  readonly confirmed: readonly ConfirmedLeg[]
  readonly expired: readonly DeadAttempt[]
  /** Legs still outstanding and already known. */
  readonly standing: number
}

/**
 * The transaction the issuer intends to send, complete before it is signed.
 *
 * Every field is stored: recovery after a crash re-sends this, byte for byte,
 * rather than rebuilding it. `expiresAfter` is the issuer's to supply — the
 * validity window is a chain fact it reads a node to learn, and a second copy
 * of that number here could only disagree with the first, exactly like a second
 * finality rule.
 */
export interface TransactionPlan {
  readonly ref: TxRef
  readonly kind: LedgerKind
  readonly sender: Address
  readonly recipient: Address
  readonly value: bigint
  readonly fee: bigint
  readonly data: string
  readonly validityStartHeight: number
  readonly expiresAfter: number
}

/** Counts for one glance at the ledger. */
export interface LedgerSummary {
  readonly due: number
  readonly claimed: number
  readonly broadcast: number
  readonly confirmed: number
  /** Luna owed and not yet confirmed paid — DUE, CLAIMED and BROADCAST together. */
  readonly outstandingLuna: bigint
  /** Luna confirmed paid, over the ledger's whole life. */
  readonly settledLuna: bigint
  readonly source: StoredSource | null
}

// ── Pure derivations ────────────────────────────────────────────────────────

/**
 * Refuse a snapshot that is not a continuation of the one last applied.
 *
 * The watcher makes the same two refusals in process; this makes them survive a
 * restart, which is the whole reason the ledger stores the source at all. A
 * rewound or forked log can put a debt this service already paid back into the
 * due set, and paying it again is the one way this design produces a double
 * payment.
 *
 * The fingerprint is the third refusal and a different failure: a ledger
 * pointed at a deployment with different §3 values keys its rows by another
 * numbering, and the symptom would be debts that are never confirmed.
 */
export function checkSource(stored: StoredSource | null, snapshot: WatchSnapshot, fingerprint: string): void {
  if (stored === null) return
  if (stored.configFingerprint !== fingerprint) {
    throw new LedgerError(
      `this ledger was written under a different §3 configuration (fingerprint ${stored.configFingerprint}, now ${fingerprint}). ` +
        `Its rows are keyed by heights from another deployment — refusing to write to it`,
    )
  }
  if (snapshot.checkpointHeight < stored.checkpointHeight) {
    throw new LedgerError(
      `the log went backwards: checkpoint ${snapshot.checkpointHeight}, ledger last applied ${stored.checkpointHeight}. ` +
        `An M already broadcast can drop out of a rewound log and its debt reappear as outstanding — refusing to write to it`,
    )
  }
  if (snapshot.checkpointHeight === stored.checkpointHeight && snapshot.logHash !== stored.logHash) {
    throw new LedgerError(
      `checkpoint ${snapshot.checkpointHeight} now commits a different log: ledger applied ${stored.logHash}, snapshot carries ${snapshot.logHash}. ` +
        `A checkpoint that changes without advancing is a fork, not an update`,
    )
  }
}

/**
 * Decide what one snapshot does to the ledger. Pure, and the whole state
 * machine lives here.
 *
 * Three refusals, all of them meaning *the log I am paying against is not the
 * log I paid against*:
 *
 * - **A confirmed debt is outstanding again.** Height-level rewind guards can
 *   miss this — a different server at a greater height would pass them — and
 *   it is the precise shape of a double payment about to happen.
 * - **A leg's amount, payer or payee changed.** The log's numbers are recorded
 *   on first sight and are never updated; a different one at the same key is a
 *   fork, not news.
 * - Neither is retryable, so neither is retried.
 */
export function planUpdate(
  entries: readonly LedgerEntry[],
  snapshot: WatchSnapshot,
): LedgerUpdate {
  const known = new Map(entries.map((entry) => [entry.key, entry]))
  const dueNow = new Set<string>()

  const inserted: DueObligation[] = []
  const expired: DeadAttempt[] = []
  let standing = 0

  for (const leg of snapshot.due) {
    dueNow.add(leg.key)
    const entry = known.get(leg.key)
    if (entry === undefined) {
      inserted.push(leg)
      continue
    }
    if (entry.state === 'CONFIRMED') {
      throw new LedgerError(
        `${leg.key} was confirmed settled at checkpoint ${entry.confirmedHeight ?? 0} and is outstanding again at ${snapshot.checkpointHeight}. ` +
          `This is not a log this ledger has been paying against — refusing to pay it twice`,
      )
    }
    if (entry.amount !== leg.amount || entry.owedTo !== leg.owedTo || entry.owedBy !== leg.owedBy) {
      throw new LedgerError(
        `${leg.key} changed under the ledger: recorded ${entry.amount} luna from ${entry.owedBy} to ${entry.owedTo}, ` +
          `the log at ${snapshot.checkpointHeight} says ${leg.amount} luna from ${leg.owedBy} to ${leg.owedTo}`,
      )
    }
    standing += 1

    // Dead: a stamped checkpoint above the window, and the leg is still owed.
    // Both halves come from this one snapshot, so no node is consulted about
    // either. Only after this may the issuer pin a replacement.
    if (entry.live !== null && entry.live.expiresAfter < snapshot.checkpointHeight) {
      expired.push({
        key: entry.key,
        ref: entry.ref,
        kind: entry.kind,
        attemptNo: entry.live.attemptNo,
        expiresAfter: entry.live.expiresAfter,
        txHash: entry.live.txHash,
        wasSent: entry.live.state === 'SENT',
      })
    }
  }

  // Absent from the due set is the definition of paid: `state.outstanding`
  // drops a leg only when an `M` discharges it (§6 `M`), and the snapshot's
  // height is a stamped one.
  const confirmed: ConfirmedLeg[] = []
  for (const entry of entries) {
    if (entry.state === 'CONFIRMED' || dueNow.has(entry.key)) continue
    confirmed.push({
      key: entry.key,
      ref: entry.ref,
      kind: entry.kind,
      confirmedHeight: snapshot.checkpointHeight,
      attemptNo: entry.live?.attemptNo ?? null,
    })
  }

  return Object.freeze({
    checkpointHeight: snapshot.checkpointHeight,
    logHash: snapshot.logHash,
    inserted: Object.freeze(inserted),
    confirmed: Object.freeze(confirmed),
    expired: Object.freeze(expired),
    standing,
  })
}

/**
 * Check a plan against the obligation it claims to pay.
 *
 * Not a protocol rule — the amounts are `core`'s, derived by the replay — but
 * the last cheap moment to notice that the issuer is about to send the wrong
 * number to the wrong address. `sender ≠ recipient` is here rather than only in
 * the schema because a self-transaction is accepted by the RPC and dropped by
 * the network with no error at any layer.
 */
export function checkPlan(entry: LedgerEntry, plan: TransactionPlan): void {
  const where = `${entry.key}: the plan`
  if (plan.value !== entry.amount) {
    throw new LedgerError(`${where} pays ${plan.value} luna, the log says ${entry.amount} is owed`)
  }
  if (plan.recipient !== entry.owedTo) {
    throw new LedgerError(`${where} pays ${formatAddress(plan.recipient)}, the log owes ${formatAddress(entry.owedTo)}`)
  }
  if (plan.sender !== entry.owedBy) {
    throw new LedgerError(
      `${where} sends from ${formatAddress(plan.sender)}, the log owes it from ${formatAddress(entry.owedBy)} (§6 M)`,
    )
  }
  if (plan.sender === plan.recipient) {
    throw new LedgerError(`${where} is a self-transaction, which the RPC accepts and the network silently drops`)
  }
  if (plan.expiresAfter < plan.validityStartHeight) {
    throw new LedgerError(
      `${where} expires at ${plan.expiresAfter}, before its validity start ${plan.validityStartHeight}`,
    )
  }
  if (!/^[0-9a-f]*$/.test(plan.data)) {
    throw new LedgerError(`${where} carries non-hex data — the RPC answers "Internal error" (§5.1)`)
  }
}

// ── The store ───────────────────────────────────────────────────────────────

/**
 * One advisory lock, held for the transaction, around every mutation.
 *
 * Two issuer processes are an operator error rather than a design, but this
 * ledger's claim is that concurrency and crashes cannot double-pay, and a claim
 * that rests on nobody starting the service twice is not one. The unique index
 * on live attempts already makes a pin race safe; the lock is what keeps the
 * *reasoning* short — a snapshot is applied against the set of rows it read.
 */
const LEDGER_LOCK = 7_273_130_001n

export interface Ledger {
  /** Apply the migrations and verify the stored source, if there is one. */
  initialise(): Promise<{ readonly migrationsRun: readonly string[]; readonly source: StoredSource | null }>
  /** Record a verified snapshot: insert new debts, confirm paid ones, expire dead attempts. */
  applySnapshot(snapshot: WatchSnapshot): Promise<LedgerUpdate>
  /** Every entry, ordered canonically. */
  entries(): Promise<readonly LedgerEntry[]>
  /** Legs the issuer may pin a transaction for: DUE, no live attempt. */
  dueForIssue(): Promise<readonly LedgerEntry[]>
  /**
   * Commit a transaction plan. **Returns only after the plan is durable**, and
   * the issuer must not sign before it does — that ordering is the whole
   * mechanism.
   */
  pin(plan: TransactionPlan): Promise<number>
  /** Record that a node returned a hash for a pinned attempt. */
  markSent(ref: TxRef, kind: LedgerKind, attemptNo: number, txHash: string): Promise<void>
  summary(): Promise<LedgerSummary>
  readSource(): Promise<StoredSource | null>
}

export interface LedgerOptions {
  readonly pool: Pool
  readonly config: NnsConfig
  readonly apiUrl: string
  readonly logger?: Logger
  /** Defaults to `migrateLedger`. A test with its own schema passes its own. */
  readonly migrate?: (pool: Pool, logger?: Logger) => Promise<string[]>
}

/**
 * Every entry, with its live attempt joined on.
 *
 * The join cannot fan out: `attempts_one_live` is a unique index over exactly
 * the two live states, so an obligation has at most one row to join to. If that
 * index were ever dropped, this query would start returning an entry twice and
 * the issuer would pin twice — which is the reason the constraint is in the
 * schema rather than in a `LIMIT 1` here.
 */
function entryQuery(where = ''): string {
  return `
    SELECT o.ref_height, o.ref_tx_index, o.kind, o.owed_by, o.owed_to, o.amount, o.state,
           o.first_seen_height, o.confirmed_height, o.attempt_count,
           a.attempt_no, a.state AS attempt_state, a.sender, a.recipient, a.value, a.fee,
           a.data, a.validity_start_height, a.expires_after, a.tx_hash
      FROM obligations o
      LEFT JOIN attempts a
        ON a.ref_height = o.ref_height
       AND a.ref_tx_index = o.ref_tx_index
       AND a.kind = o.kind
       AND a.state IN ('PINNED', 'SENT')
     ${where}
     ORDER BY o.ref_height, o.ref_tx_index, o.kind
  `
}

/** CHAR(36) is fixed width and the compact form is exactly 36, but a driver may still pad. */
const address = (value: unknown, field: string): Address => {
  if (typeof value !== 'string') throw new LedgerError(`${field}: ${JSON.stringify(value)} is not an address`)
  try {
    return parseAddress(value)
  } catch (cause) {
    throw new LedgerError(`${field}: ${JSON.stringify(value)} is not an address — ${(cause as Error).message}`)
  }
}

function toEntry(row: Record<string, unknown>): LedgerEntry {
  const ref: TxRef = { height: Number(row['ref_height']), txIndex: Number(row['ref_tx_index']) }
  const kind = String(row['kind']) as LedgerKind
  const attemptNo = row['attempt_no']
  const live: LiveAttempt | null =
    attemptNo === null || attemptNo === undefined
      ? null
      : {
          attemptNo: Number(attemptNo),
          state: String(row['attempt_state']) as 'PINNED' | 'SENT',
          sender: address(row['sender'], 'sender'),
          recipient: address(row['recipient'], 'recipient'),
          value: toLuna(row['value'], 'value'),
          fee: toLuna(row['fee'], 'fee'),
          data: String(row['data']),
          validityStartHeight: Number(row['validity_start_height']),
          expiresAfter: Number(row['expires_after']),
          txHash: row['tx_hash'] === null ? null : String(row['tx_hash']),
        }
  return {
    key: `${refKey(ref)}:${kind}`,
    ref,
    kind,
    owedBy: address(row['owed_by'], 'owed_by'),
    owedTo: address(row['owed_to'], 'owed_to'),
    amount: toLuna(row['amount'], 'amount'),
    state: String(row['state']) as ObligationState,
    firstSeenHeight: Number(row['first_seen_height']),
    confirmedHeight: row['confirmed_height'] === null ? null : Number(row['confirmed_height']),
    attemptCount: Number(row['attempt_count']),
    live,
  }
}

export function createLedger(options: LedgerOptions): Ledger {
  const { pool, config, apiUrl, logger } = options
  const fingerprint = configFingerprint(config)

  const readSource = async (client: Pool | PoolClient): Promise<StoredSource | null> => {
    const { rows } = await client.query<Record<string, unknown>>(
      'SELECT api_url, config_fingerprint, checkpoint_height, log_hash FROM source WHERE id = 1',
    )
    const [row] = rows
    if (row === undefined) return null
    return {
      apiUrl: String(row['api_url']),
      configFingerprint: String(row['config_fingerprint']),
      checkpointHeight: Number(row['checkpoint_height']),
      logHash: String(row['log_hash']),
    }
  }

  const lock = (client: PoolClient) => client.query('SELECT pg_advisory_xact_lock($1)', [LEDGER_LOCK.toString()])

  const entriesOf = async (client: Pool | PoolClient, where = '', params: unknown[] = []): Promise<LedgerEntry[]> => {
    const { rows } = await client.query<Record<string, unknown>>(entryQuery(where), params)
    return rows.map(toEntry)
  }

  return {
    async initialise() {
      const migrate = options.migrate ?? migrateLedger
      const migrationsRun = await migrate(pool, logger)
      const source = await readSource(pool)
      if (source !== null && source.configFingerprint !== fingerprint) {
        throw new LedgerError(
          `this ledger was written under a different §3 configuration (fingerprint ${source.configFingerprint}, now ${fingerprint}). ` +
            `Its rows are keyed by heights from another deployment — refusing to open it`,
        )
      }
      // A moved hostname is routine and the log hash chain is what actually
      // guards continuity, so this is a warning rather than a refusal.
      if (source !== null && source.apiUrl !== apiUrl) {
        logger?.warn('ledger.source.moved', { was: source.apiUrl, now: apiUrl })
      }
      return { migrationsRun, source }
    },

    readSource: () => readSource(pool),

    entries: () => entriesOf(pool),

    dueForIssue: () => entriesOf(pool, "WHERE o.state = 'DUE' AND a.attempt_no IS NULL"),

    async applySnapshot(snapshot) {
      return withTransaction(pool, async (client) => {
        await lock(client)
        const stored = await readSource(client)
        checkSource(stored, snapshot, fingerprint)

        const update = planUpdate(await entriesOf(client), snapshot)

        for (const leg of update.inserted) {
          await client.query(
            `INSERT INTO obligations
               (ref_height, ref_tx_index, kind, owed_by, owed_to, amount, state, first_seen_height)
             VALUES ($1, $2, $3, $4, $5, $6, 'DUE', $7)`,
            [leg.ref.height, leg.ref.txIndex, leg.kind, leg.owedBy, leg.owedTo, leg.amount.toString(10), snapshot.checkpointHeight],
          )
        }

        for (const leg of update.confirmed) {
          const { height, txIndex } = leg.ref
          const kind = leg.kind
          await client.query(
            `UPDATE obligations
                SET state = 'CONFIRMED', confirmed_height = $4, updated_at = now()
              WHERE ref_height = $1 AND ref_tx_index = $2 AND kind = $3`,
            [height, txIndex, kind, leg.confirmedHeight],
          )
          if (leg.attemptNo !== null) {
            await client.query(
              `UPDATE attempts
                  SET state = 'CONFIRMED', settled_height = $5
                WHERE ref_height = $1 AND ref_tx_index = $2 AND kind = $3 AND attempt_no = $4`,
              [height, txIndex, kind, leg.attemptNo, leg.confirmedHeight],
            )
          }
        }

        for (const dead of update.expired) {
          const { height, txIndex } = dead.ref
          const kind = dead.kind
          await client.query(
            `UPDATE attempts SET state = 'EXPIRED'
              WHERE ref_height = $1 AND ref_tx_index = $2 AND kind = $3 AND attempt_no = $4`,
            [height, txIndex, kind, dead.attemptNo],
          )
          // Back to DUE, with `attempt_count` remembering how many transactions
          // this leg has already cost. The next pin is attempt_count + 1.
          await client.query(
            `UPDATE obligations SET state = 'DUE', updated_at = now()
              WHERE ref_height = $1 AND ref_tx_index = $2 AND kind = $3`,
            [height, txIndex, kind],
          )
        }

        await client.query(
          `INSERT INTO source (id, api_url, config_fingerprint, checkpoint_height, log_hash)
           VALUES (1, $1, $2, $3, $4)
           ON CONFLICT (id) DO UPDATE
             SET api_url = EXCLUDED.api_url,
                 config_fingerprint = EXCLUDED.config_fingerprint,
                 checkpoint_height = EXCLUDED.checkpoint_height,
                 log_hash = EXCLUDED.log_hash,
                 updated_at = now()`,
          [apiUrl, fingerprint, snapshot.checkpointHeight, snapshot.logHash],
        )

        logger?.info('ledger.applied', {
          checkpointHeight: update.checkpointHeight,
          inserted: update.inserted.length,
          confirmed: update.confirmed.length,
          expired: update.expired.length,
          standing: update.standing,
        })
        return update
      })
    },

    async pin(plan) {
      return withTransaction(pool, async (client) => {
        await lock(client)
        const [entry] = await entriesOf(
          client,
          'WHERE o.ref_height = $1 AND o.ref_tx_index = $2 AND o.kind = $3',
          [plan.ref.height, plan.ref.txIndex, plan.kind],
        )
        if (entry === undefined) {
          throw new LedgerError(
            `${refKey(plan.ref)}:${plan.kind} is not in the ledger — only a leg the log says is owed can be pinned`,
          )
        }
        if (entry.state !== 'DUE') {
          throw new LedgerError(
            `${entry.key} is ${entry.state}${entry.live === null ? '' : ` under attempt ${entry.live.attemptNo}`} — ` +
              `a second live transaction for one leg is exactly the double payment this ledger prevents`,
          )
        }
        checkPlan(entry, plan)

        const attemptNo = entry.attemptCount + 1
        await client.query(
          `INSERT INTO attempts
             (ref_height, ref_tx_index, kind, attempt_no, state, sender, recipient, value, fee, data,
              validity_start_height, expires_after)
           VALUES ($1, $2, $3, $4, 'PINNED', $5, $6, $7, $8, $9, $10, $11)`,
          [
            plan.ref.height,
            plan.ref.txIndex,
            plan.kind,
            attemptNo,
            plan.sender,
            plan.recipient,
            plan.value.toString(10),
            plan.fee.toString(10),
            plan.data,
            plan.validityStartHeight,
            plan.expiresAfter,
          ],
        )
        await client.query(
          `UPDATE obligations
              SET state = 'CLAIMED', attempt_count = $4, updated_at = now()
            WHERE ref_height = $1 AND ref_tx_index = $2 AND kind = $3`,
          [plan.ref.height, plan.ref.txIndex, plan.kind, attemptNo],
        )
        logger?.info('ledger.pinned', { key: entry.key, attemptNo, validityStartHeight: plan.validityStartHeight })
        return attemptNo
      })
    },

    async markSent(ref, kind, attemptNo, txHash) {
      await withTransaction(pool, async (client) => {
        await lock(client)
        const { rows } = await client.query<{ state: string; tx_hash: string | null }>(
          `SELECT state, tx_hash FROM attempts
            WHERE ref_height = $1 AND ref_tx_index = $2 AND kind = $3 AND attempt_no = $4`,
          [ref.height, ref.txIndex, kind, attemptNo],
        )
        const [row] = rows
        if (row === undefined) {
          throw new LedgerError(`${refKey(ref)}:${kind} has no attempt ${attemptNo} to mark sent`)
        }
        // Idempotent for the same hash: a crash between the node's reply and
        // this write leaves the issuer re-sending the identical transaction,
        // which the network collapses to the same hash.
        if (row.state === 'SENT') {
          if (row.tx_hash === txHash) return
          throw new LedgerError(
            `${refKey(ref)}:${kind} attempt ${attemptNo} was already sent as ${row.tx_hash}, now reported as ${txHash}. ` +
              `Two hashes for one pinned plan means the plan was not re-sent verbatim`,
          )
        }
        if (row.state !== 'PINNED') {
          throw new LedgerError(`${refKey(ref)}:${kind} attempt ${attemptNo} is ${row.state}, not PINNED`)
        }
        await client.query(
          `UPDATE attempts SET state = 'SENT', tx_hash = $5, sent_at = now()
            WHERE ref_height = $1 AND ref_tx_index = $2 AND kind = $3 AND attempt_no = $4`,
          [ref.height, ref.txIndex, kind, attemptNo, txHash],
        )
        await client.query(
          `UPDATE obligations SET state = 'BROADCAST', updated_at = now()
            WHERE ref_height = $1 AND ref_tx_index = $2 AND kind = $3`,
          [ref.height, ref.txIndex, kind],
        )
        logger?.info('ledger.sent', { key: `${refKey(ref)}:${kind}`, attemptNo, txHash })
      })
    },

    async summary() {
      const entries = await entriesOf(pool)
      let outstandingLuna = 0n
      let settledLuna = 0n
      const counts = { DUE: 0, CLAIMED: 0, BROADCAST: 0, CONFIRMED: 0 }
      for (const entry of entries) {
        counts[entry.state] += 1
        if (entry.state === 'CONFIRMED') settledLuna += entry.amount
        else outstandingLuna += entry.amount
      }
      return {
        due: counts.DUE,
        claimed: counts.CLAIMED,
        broadcast: counts.BROADCAST,
        confirmed: counts.CONFIRMED,
        outstandingLuna,
        settledLuna,
        source: await readSource(pool),
      }
    },
  }
}

/** The key an entry or an obligation is stored under. Re-exported so the issuer needs one import. */
export { obligationKey }

// ── Rendering ───────────────────────────────────────────────────────────────

/** 1 NIM = 100,000 luna, and luna is `bigint`. Rendered, never computed on. */
function nim(luna: bigint): string {
  const whole = luna / 100_000n
  return `${whole.toString()}.${(luna % 100_000n).toString().padStart(5, '0')}`
}

export function describeLedger(entries: readonly LedgerEntry[], summary: LedgerSummary): readonly string[] {
  const out: string[] = []
  const source = summary.source
  out.push(
    source === null
      ? 'ledger is empty — no snapshot has been applied yet'
      : `ledger applied through checkpoint ${source.checkpointHeight}, log ${source.logHash}`,
  )
  out.push(
    `${summary.due} due · ${summary.claimed} claimed · ${summary.broadcast} broadcast · ${summary.confirmed} confirmed` +
      ` — ${nim(summary.outstandingLuna)} NIM not yet confirmed paid, ${nim(summary.settledLuna)} NIM settled`,
  )

  const live = entries.filter((entry) => entry.state !== 'CONFIRMED')
  if (live.length > 0) {
    out.push('')
    out.push(['key'.padEnd(26), 'state'.padEnd(10), 'NIM'.padStart(14), 'att', 'transaction'].join(' '))
    for (const entry of live) {
      out.push(
        [
          entry.key.padEnd(26),
          entry.state.padEnd(10),
          nim(entry.amount).padStart(14),
          String(entry.attemptCount).padStart(3),
          entry.live?.txHash ?? (entry.live === null ? '—' : `pinned, expires ${entry.live.expiresAfter}`),
        ].join(' '),
      )
    }
  }

  const foreign = entries.filter((entry) => entry.state === 'CONFIRMED' && entry.attemptCount === 0)
  if (foreign.length > 0) {
    out.push('')
    out.push(
      `${foreign.length} leg(s) were settled without this ledger pinning anything — paid by hand, or by another issuer:`,
    )
    for (const entry of foreign) out.push(`  ${entry.key}, ${nim(entry.amount)} NIM, at ${entry.confirmedHeight}`)
  }

  return out
}
