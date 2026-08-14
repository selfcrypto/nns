/**
 * The ledger: its state machine, and its SQL.
 *
 * The state machine is pure and runs unconditionally — `planUpdate`,
 * `checkSource` and `checkPlan` are where every claim about double payment
 * actually lives, and none of them needs a database to be true.
 *
 * Everything under the Postgres gate is the part a mock could not check: the
 * unique index that makes a second live attempt impossible, the transaction
 * boundaries, and the crash rehearsals — which are run by throwing the `Ledger`
 * object away and building a new one over the same pool, since that is exactly
 * what a restart is.
 *
 *   NNS_TEST_DATABASE_URL=postgres://…/throwaway pnpm vitest run --project settlement
 *
 * **This suite owns the schema `settlement_test`.** It drops and recreates it on
 * arrival, like the indexer's and the API's suites own theirs, so all three can
 * point at one throwaway database and run in parallel.
 */

import {
  CONSTANTS,
  commissionOn,
  encodeBuy,
  encodeOffer,
  encodeRegister,
  feeFor,
  initialState,
  minPrice,
  logHash as coreLogHash,
  type Address,
  type ObligationKind,
} from '@nns/core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPool, migrateLedger, type Pool } from './db.js'
import {
  checkPlan,
  checkSource,
  createLedger,
  describeLedger,
  LedgerError,
  planUpdate,
  type LedgerEntry,
  type LiveAttempt,
  type TransactionPlan,
} from './ledger.js'
import { replayLog } from './replay.js'
import { LAUNCH_HEIGHT, LOSER, MARKETPLACE, SELLER, TREASURY, WINNER, send, stageLog, testConfig } from './test-fixtures.js'
import { takeSnapshot, type DueObligation, type WatchSnapshot } from './watch.js'
import type { LogSnapshot } from './source.js'

const config = testConfig()

// ── Builders ────────────────────────────────────────────────────────────────

const leg = (
  height: number,
  txIndex: number,
  kind: ObligationKind,
  amount: bigint,
  owedTo: Address = SELLER,
  owedBy: Address = MARKETPLACE,
): DueObligation => ({
  key: `${height}:${txIndex}:${kind}`,
  kind,
  ref: { height, txIndex },
  owedBy,
  owedTo,
  amount,
  ageBlocks: 0,
})

const snapshotOf = (checkpointHeight: number, due: readonly DueObligation[], logHash = 'ab'.repeat(32)): WatchSnapshot =>
  Object.freeze({
    checkpointHeight,
    logHash,
    lineCount: due.length,
    due: Object.freeze([...due]),
    totalDue: due.reduce((sum, item) => sum + item.amount, 0n),
    unmatched: [],
  })

const entryOf = (due: DueObligation, overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  key: due.key,
  ref: due.ref,
  kind: due.kind,
  owedBy: due.owedBy,
  owedTo: due.owedTo,
  amount: due.amount,
  state: 'DUE',
  firstSeenHeight: 1_000,
  confirmedHeight: null,
  attemptCount: 0,
  live: null,
  ...overrides,
})

const liveAttempt = (overrides: Partial<LiveAttempt> = {}): LiveAttempt => ({
  attemptNo: 1,
  state: 'PINNED',
  sender: MARKETPLACE,
  recipient: SELLER,
  value: 500n,
  fee: 0n,
  data: '4e4e53314d',
  validityStartHeight: 1_000,
  expiresAfter: 1_120,
  txHash: null,
  ...overrides,
})

const planOf = (entry: LedgerEntry, overrides: Partial<TransactionPlan> = {}): TransactionPlan => ({
  ref: entry.ref,
  kind: entry.kind,
  sender: entry.owedBy,
  recipient: entry.owedTo,
  value: entry.amount,
  fee: 0n,
  data: '4e4e53314d31303a30',
  validityStartHeight: 2_000,
  expiresAfter: 2_120,
  ...overrides,
})

// ── The state machine ───────────────────────────────────────────────────────

describe('planUpdate', () => {
  const first = leg(1_010, 0, 'SALE_PROCEEDS', 487_50001n)
  const second = leg(1_010, 0, 'COMMISSION', 12_50000n, TREASURY)

  it('inserts a leg it has never seen', () => {
    const update = planUpdate([], snapshotOf(1_440, [first, second]))
    expect(update.inserted.map((item) => item.key)).toEqual([first.key, second.key])
    expect(update.confirmed).toEqual([])
    expect(update.standing).toBe(0)
  })

  it('inserts nothing for a leg it already holds — a re-read of the whole log changes nothing', () => {
    const update = planUpdate([entryOf(first)], snapshotOf(1_440, [first]))
    expect(update.inserted).toEqual([])
    expect(update.standing).toBe(1)
  })

  // Absence from the due set is the definition of paid: `state.outstanding`
  // drops a leg only when an `M` discharges it, and the height is stamped.
  it('confirms a leg that has left the due set, naming the attempt that paid it', () => {
    const entry = entryOf(first, { state: 'BROADCAST', attemptCount: 1, live: liveAttempt({ state: 'SENT', txHash: 'ff' }) })
    const update = planUpdate([entry], snapshotOf(1_440, []))
    expect(update.confirmed).toEqual([
      { key: first.key, ref: first.ref, kind: first.kind, confirmedHeight: 1_440, attemptNo: 1 },
    ])
  })

  it('confirms a leg nobody here ever pinned — paid by hand, or by another issuer', () => {
    const update = planUpdate([entryOf(first)], snapshotOf(1_440, []))
    expect(update.confirmed[0]?.attemptNo).toBeNull()
  })

  it('leaves an already-confirmed leg alone', () => {
    const entry = entryOf(first, { state: 'CONFIRMED', confirmedHeight: 1_440 })
    expect(planUpdate([entry], snapshotOf(2_160, [])).confirmed).toEqual([])
  })

  it('does not expire an attempt whose window is still open', () => {
    const entry = entryOf(first, { state: 'CLAIMED', attemptCount: 1, live: liveAttempt({ expiresAfter: 1_500 }) })
    expect(planUpdate([entry], snapshotOf(1_440, [first])).expired).toEqual([])
  })

  // The one rule that lets a pinned transaction be replaced, and the only place
  // a second transaction for one leg can ever come from.
  it('expires an attempt past its window that the log still says is owed', () => {
    const entry = entryOf(first, {
      state: 'BROADCAST',
      attemptCount: 1,
      live: liveAttempt({ state: 'SENT', txHash: 'aa', expiresAfter: 1_439 }),
    })
    const update = planUpdate([entry], snapshotOf(1_440, [first]))
    expect(update.expired).toEqual([
      { key: first.key, ref: first.ref, kind: first.kind, attemptNo: 1, expiresAfter: 1_439, txHash: 'aa', wasSent: true },
    ])
  })

  // One block of slack against an off-by-one in the issuer's window, and it
  // costs nothing: checkpoints are CHECKPOINT_INTERVAL apart, so the next
  // snapshot is 720 blocks away either way.
  it('does not expire an attempt whose window ends exactly at the checkpoint', () => {
    const entry = entryOf(first, { state: 'CLAIMED', attemptCount: 1, live: liveAttempt({ expiresAfter: 1_440 }) })
    expect(planUpdate([entry], snapshotOf(1_440, [first])).expired).toEqual([])
  })

  it('refuses a leg that was confirmed settled and is outstanding again', () => {
    const entry = entryOf(first, { state: 'CONFIRMED', confirmedHeight: 1_440 })
    expect(() => planUpdate([entry], snapshotOf(2_160, [first]))).toThrow(LedgerError)
    expect(() => planUpdate([entry], snapshotOf(2_160, [first]))).toThrow(/outstanding again/)
  })

  it('refuses a leg whose amount changed under it', () => {
    const entry = entryOf(first)
    expect(() => planUpdate([entry], snapshotOf(1_440, [{ ...first, amount: first.amount + 1n }]))).toThrow(
      /changed under the ledger/,
    )
  })

  it('refuses a leg whose payee changed under it', () => {
    const entry = entryOf(first)
    expect(() => planUpdate([entry], snapshotOf(1_440, [{ ...first, owedTo: WINNER }]))).toThrow(LedgerError)
  })
})

describe('checkSource', () => {
  const stored = { apiUrl: 'http://a', configFingerprint: 'f', checkpointHeight: 1_440, logHash: 'aa' }

  it('accepts an empty ledger', () => {
    expect(() => checkSource(null, snapshotOf(1_440, []), 'f')).not.toThrow()
  })

  it('accepts the same checkpoint with the same log', () => {
    expect(() => checkSource(stored, snapshotOf(1_440, [], 'aa'), 'f')).not.toThrow()
  })

  it('accepts a later checkpoint', () => {
    expect(() => checkSource(stored, snapshotOf(2_160, [], 'bb'), 'f')).not.toThrow()
  })

  // The one way this design double-pays: an M already broadcast drops out of a
  // rewound log and its debt reappears. The watcher refuses it in process; this
  // is what makes the refusal survive a restart.
  it('refuses a rewind', () => {
    expect(() => checkSource(stored, snapshotOf(720, [], 'aa'), 'f')).toThrow(/went backwards/)
  })

  it('refuses a fork at a height already applied', () => {
    expect(() => checkSource(stored, snapshotOf(1_440, [], 'bb'), 'f')).toThrow(/fork, not an update/)
  })

  it('refuses a ledger written under different §3 values', () => {
    expect(() => checkSource(stored, snapshotOf(2_160, [], 'bb'), 'other')).toThrow(/different §3 configuration/)
  })
})

describe('checkPlan', () => {
  const entry = entryOf(leg(1_010, 0, 'SALE_PROCEEDS', 500n))

  it('accepts a plan that matches the obligation', () => {
    expect(() => checkPlan(entry, planOf(entry))).not.toThrow()
  })

  it('refuses a plan paying the wrong amount', () => {
    expect(() => checkPlan(entry, planOf(entry, { value: 499n }))).toThrow(/pays 499 luna/)
  })

  it('refuses a plan paying the wrong address', () => {
    expect(() => checkPlan(entry, planOf(entry, { recipient: WINNER }))).toThrow(LedgerError)
  })

  it('refuses a plan sent from an address that does not owe it (§6 M)', () => {
    expect(() => checkPlan(entry, planOf(entry, { sender: TREASURY }))).toThrow(/§6 M/)
  })

  // Accepted by the RPC, silently dropped by the network, no error at any layer.
  it('refuses a self-transaction', () => {
    const self = entryOf(leg(1_010, 0, 'SALE_PROCEEDS', 500n, MARKETPLACE))
    expect(() => checkPlan(self, planOf(self))).toThrow(/self-transaction/)
  })

  it('refuses a window that ends before it starts', () => {
    expect(() => checkPlan(entry, planOf(entry, { expiresAfter: 1_999 }))).toThrow(/before its validity start/)
  })

  it('refuses non-hex data', () => {
    expect(() => checkPlan(entry, planOf(entry, { data: 'NNS1M1010:0' }))).toThrow(/non-hex/)
  })
})

describe('describeLedger', () => {
  it('names legs settled without this ledger pinning anything', () => {
    const entry = entryOf(leg(1_010, 0, 'REFUND', 500n), { state: 'CONFIRMED', confirmedHeight: 1_440 })
    const lines = describeLedger([entry], {
      due: 0,
      claimed: 0,
      broadcast: 0,
      confirmed: 1,
      outstandingLuna: 0n,
      settledLuna: 500n,
      source: { apiUrl: 'http://a', configFingerprint: 'f', checkpointHeight: 1_440, logHash: 'aa' },
    })
    expect(lines.join('\n')).toMatch(/settled without this ledger pinning anything/)
  })
})

// ── The SQL ─────────────────────────────────────────────────────────────────

const URL = process.env['NNS_TEST_DATABASE_URL']
const SCHEMA = 'settlement_test'
const POOL_URL =
  URL === undefined
    ? ''
    : `${URL}${URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`

describe.skipIf(URL === undefined)('Ledger over Postgres', () => {
  let pool: Pool

  const ledgerOf = () => createLedger({ pool, config, apiUrl: 'http://api.test' })

  beforeAll(async () => {
    pool = createPool(POOL_URL)
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`)
  })

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`)
    await migrateLedger(pool)
  })

  const first = leg(1_010, 0, 'SALE_PROCEEDS', 487_50001n)
  const commission = leg(1_010, 0, 'COMMISSION', 12_50000n, TREASURY)

  /** Entries come back in key order, where COMMISSION sorts before SALE_PROCEEDS. */
  const byKind = (entries: readonly LedgerEntry[], kind: ObligationKind): LedgerEntry => {
    const found = entries.find((entry) => entry.kind === kind)
    if (found === undefined) throw new Error(`no ${kind} entry`)
    return found
  }

  it('applies its own migrations, and only its own', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [SCHEMA],
    )
    // `names`, `log` and `checkpoints` here would mean the indexer's migrations
    // had been run against the ledger's database.
    expect(rows.map((row) => row.table_name)).toEqual(['attempts', 'obligations', 'schema_migrations', 'source'])
  })

  it('records the due set, and re-reading the same log inserts nothing', async () => {
    const ledger = ledgerOf()
    const snapshot = snapshotOf(1_440, [first, commission])
    const one = await ledger.applySnapshot(snapshot)
    expect(one.inserted).toHaveLength(2)

    // The same bytes again — a restart, a duplicate poll, a re-read from height
    // zero. All of them re-derive the same keys and collide with these rows.
    const two = await ledger.applySnapshot(snapshot)
    expect(two.inserted).toEqual([])
    expect(two.standing).toBe(2)
    expect(await ledger.entries()).toHaveLength(2)
  })

  it('remembers which log it is paying against across a restart', async () => {
    await ledgerOf().applySnapshot(snapshotOf(1_440, [first]))
    // A new object over the same database is what a restart actually is.
    const restarted = ledgerOf()
    const { source } = await restarted.initialise()
    expect(source?.checkpointHeight).toBe(1_440)
    await expect(restarted.applySnapshot(snapshotOf(720, [first]))).rejects.toThrow(/went backwards/)
  })

  it('refuses to open a ledger written under different §3 values', async () => {
    await ledgerOf().applySnapshot(snapshotOf(1_440, [first]))
    const other = createLedger({
      pool,
      config: testConfig({ networkId: config.networkId + 1 }),
      apiUrl: 'http://api.test',
      migrate: async () => [],
    })
    await expect(other.initialise()).rejects.toThrow(/different §3 configuration/)
  })

  it('pins a plan, and the obligation leaves the issuable set', async () => {
    const ledger = ledgerOf()
    await ledger.applySnapshot(snapshotOf(1_440, [first, commission]))
    const entry = byKind(await ledger.dueForIssue(), 'SALE_PROCEEDS')

    const attemptNo = await ledger.pin(planOf(entry))
    expect(attemptNo).toBe(1)
    expect((await ledger.dueForIssue()).map((item) => item.key)).toEqual([commission.key])
    const after = byKind(await ledger.entries(), 'SALE_PROCEEDS')
    expect(after.state).toBe('CLAIMED')
    expect(after.live?.state).toBe('PINNED')
  })

  it('refuses a second live plan for one leg', async () => {
    const ledger = ledgerOf()
    await ledger.applySnapshot(snapshotOf(1_440, [first]))
    const entry = (await ledger.entries())[0] as LedgerEntry
    await ledger.pin(planOf(entry))
    await expect(ledger.pin(planOf(entry, { validityStartHeight: 2_500, expiresAfter: 2_620 }))).rejects.toThrow(
      /is CLAIMED/,
    )
  })

  // The refusal above reads the row first. This one goes around it, because a
  // guard that lives in application code has a window between the check and the
  // insert, and a crash likes exactly that window.
  it('makes a second live attempt impossible in the schema itself', async () => {
    const ledger = ledgerOf()
    await ledger.applySnapshot(snapshotOf(1_440, [first]))
    const entry = (await ledger.entries())[0] as LedgerEntry
    await ledger.pin(planOf(entry))
    await expect(
      pool.query(
        `INSERT INTO attempts (ref_height, ref_tx_index, kind, attempt_no, state, sender, recipient, value, fee, data,
                               validity_start_height, expires_after)
         VALUES ($1, $2, $3, 2, 'PINNED', $4, $5, $6, 0, 'aa', 2500, 2620)`,
        [entry.ref.height, entry.ref.txIndex, entry.kind, MARKETPLACE, SELLER, entry.amount.toString(10)],
      ),
    ).rejects.toThrow(/attempts_one_live/)
  })

  it('refuses a plan that does not pay what the log says is owed', async () => {
    const ledger = ledgerOf()
    await ledger.applySnapshot(snapshotOf(1_440, [first]))
    const entry = (await ledger.entries())[0] as LedgerEntry
    await expect(ledger.pin(planOf(entry, { value: entry.amount - 1n }))).rejects.toThrow(LedgerError)
    expect((await ledger.entries())[0]?.state).toBe('DUE')
  })

  it('refuses to pin a leg the log never said was owed', async () => {
    const ledger = ledgerOf()
    await ledger.applySnapshot(snapshotOf(1_440, [first]))
    const stranger = entryOf(leg(9_999, 3, 'REFUND', 100n))
    await expect(ledger.pin(planOf(stranger))).rejects.toThrow(/not in the ledger/)
  })

  // The crash this ledger exists for: the plan is committed, the broadcast
  // outcome is unknown, and recovery must re-send *these exact bytes* — a
  // recomputed validityStartHeight would be a second valid transaction.
  it('hands a restart back the pinned plan, byte for byte', async () => {
    const ledger = ledgerOf()
    await ledger.applySnapshot(snapshotOf(1_440, [first]))
    const entry = (await ledger.entries())[0] as LedgerEntry
    const plan = planOf(entry, { validityStartHeight: 1_437, expiresAfter: 1_557, data: 'deadbeef' })
    await ledger.pin(plan)

    const recovered = (await ledgerOf().entries())[0]?.live
    expect(recovered).toMatchObject({
      state: 'PINNED',
      sender: plan.sender,
      recipient: plan.recipient,
      value: plan.value,
      fee: plan.fee,
      data: 'deadbeef',
      validityStartHeight: 1_437,
      expiresAfter: 1_557,
      txHash: null,
    })
  })

  it('records a broadcast, and takes the same hash twice without complaint', async () => {
    const ledger = ledgerOf()
    await ledger.applySnapshot(snapshotOf(1_440, [first]))
    const entry = (await ledger.entries())[0] as LedgerEntry
    const attemptNo = await ledger.pin(planOf(entry))

    await ledger.markSent(entry.ref, entry.kind, attemptNo, 'abc123')
    expect((await ledger.entries())[0]?.state).toBe('BROADCAST')
    // Identical re-broadcasts share one hash and land at most once, so being
    // told the same hash again is the normal recovery path, not an error.
    await ledger.markSent(entry.ref, entry.kind, attemptNo, 'abc123')
    await expect(ledger.markSent(entry.ref, entry.kind, attemptNo, 'different')).rejects.toThrow(/Two hashes/)
  })

  it('confirms a leg when the log stops saying it is owed', async () => {
    const ledger = ledgerOf()
    await ledger.applySnapshot(snapshotOf(1_440, [first, commission]))
    const entry = byKind(await ledger.entries(), 'SALE_PROCEEDS')
    const attemptNo = await ledger.pin(planOf(entry))
    await ledger.markSent(entry.ref, entry.kind, attemptNo, 'abc123')

    const update = await ledger.applySnapshot(snapshotOf(2_160, [commission], 'cd'.repeat(32)))
    expect(update.confirmed).toEqual([
      { key: first.key, ref: first.ref, kind: first.kind, confirmedHeight: 2_160, attemptNo: 1 },
    ])
    const confirmed = byKind(await ledger.entries(), 'SALE_PROCEEDS')
    expect(confirmed.state).toBe('CONFIRMED')
    expect(confirmed.confirmedHeight).toBe(2_160)
    expect(confirmed.live).toBeNull()

    const { rows } = await pool.query<{ state: string; settled_height: string }>(
      `SELECT state, settled_height FROM attempts WHERE kind = 'SALE_PROCEEDS'`,
    )
    expect(rows[0]?.state).toBe('CONFIRMED')
    expect(Number(rows[0]?.settled_height)).toBe(2_160)

    const summary = await ledger.summary()
    expect(summary.confirmed).toBe(1)
    expect(summary.settledLuna).toBe(first.amount)
    expect(summary.outstandingLuna).toBe(commission.amount)
  })

  it('expires a dead transaction and lets the leg be pinned again', async () => {
    const ledger = ledgerOf()
    await ledger.applySnapshot(snapshotOf(1_440, [first]))
    const entry = (await ledger.entries())[0] as LedgerEntry
    const attemptNo = await ledger.pin(planOf(entry, { validityStartHeight: 1_400, expiresAfter: 1_520 }))
    await ledger.markSent(entry.ref, entry.kind, attemptNo, 'lost')

    // Past the window, and the log at a stamped height still says it is owed:
    // the transaction can never land, and only now may another be pinned.
    const update = await ledger.applySnapshot(snapshotOf(2_160, [first], 'cd'.repeat(32)))
    expect(update.expired).toMatchObject([{ key: first.key, attemptNo: 1, wasSent: true, txHash: 'lost' }])

    const again = (await ledger.entries())[0] as LedgerEntry
    expect(again.state).toBe('DUE')
    expect(again.attemptCount).toBe(1)
    expect(again.live).toBeNull()

    expect(await ledger.pin(planOf(again, { validityStartHeight: 2_150, expiresAfter: 2_270 }))).toBe(2)
    const { rows } = await pool.query<{ attempt_no: number; state: string }>(
      `SELECT attempt_no, state FROM attempts ORDER BY attempt_no`,
    )
    // The dead transaction is kept: it is the record of what was signed.
    expect(rows).toMatchObject([
      { attempt_no: 1, state: 'EXPIRED' },
      { attempt_no: 2, state: 'PINNED' },
    ])
  })

  it('refuses a log in which a confirmed debt is outstanding again', async () => {
    const ledger = ledgerOf()
    await ledger.applySnapshot(snapshotOf(1_440, [first]))
    await ledger.applySnapshot(snapshotOf(2_160, [], 'cd'.repeat(32)))
    await expect(ledger.applySnapshot(snapshotOf(2_880, [first], 'ef'.repeat(32)))).rejects.toThrow(/outstanding again/)
    // And the refusal left nothing half-written.
    expect((await ledger.entries())[0]?.state).toBe('CONFIRMED')
  })

  // End to end over a real staged log: the same path the CLI takes, from
  // §8.2 lines through the replay and the watcher's snapshot into the ledger.
  it('takes a real log through the watcher and records what it owes', async () => {
    const name = 'alicename'
    const price = 50_000_001n
    const prices = initialState(config).prices
    const staged = stageLog(
      [
        send(LAUNCH_HEIGHT + 10, 0, SELLER, encodeRegister(config, { name, fee: feeFor(name, prices) })),
        send(LAUNCH_HEIGHT + 20, 0, SELLER, encodeOffer(config, { name, price, minPrice: minPrice(prices) })),
        send(LAUNCH_HEIGHT + 30, 0, WINNER, encodeBuy(config, { name, price })),
        send(LAUNCH_HEIGHT + 30, 1, LOSER, encodeBuy(config, { name, price })),
      ],
      config,
    )
    const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    const height = LAUNCH_HEIGHT + CONSTANTS.CHECKPOINT_INTERVAL
    const log: LogSnapshot = {
      lines: staged.lines,
      checkpointHeight: height,
      logHash: hex(coreLogHash(staged.lines)),
      boundToCheckpoint: true,
    }
    const snapshot = takeSnapshot(log, replayLog(staged.lines, initialState(config), config))

    const update = await ledgerOf().applySnapshot(snapshot)
    expect(update.inserted).toHaveLength(3)
    const entries = await ledgerOf().entries()
    // One sale, two legs; one race loser, refunded in full and never deducted from.
    expect(entries.map((entry) => entry.kind).sort()).toEqual(['COMMISSION', 'REFUND', 'SALE_PROCEEDS'])
    const proceeds = entries.find((entry) => entry.kind === 'SALE_PROCEEDS')
    const cut = entries.find((entry) => entry.kind === 'COMMISSION')
    expect(cut?.amount).toBe(commissionOn(price, CONSTANTS.COMMISSION_RATE))
    expect((proceeds?.amount ?? 0n) + (cut?.amount ?? 0n)).toBe(price)
    expect(entries.find((entry) => entry.kind === 'REFUND')?.amount).toBe(price)
  })
})
