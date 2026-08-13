/**
 * `NnsState` ↔ database rows. **Pure — no I/O**, so the mapping that has to be
 * exact is testable without a Postgres.
 *
 * The invariant this file exists to hold: `stateFromRows(rowsOf(s))` is `s`,
 * field for field. State is kept in memory during a run and reloaded from
 * these tables on restart, so a field that fails to round-trip is a divergence
 * that appears only after a restart — the hardest kind to find and the exact
 * kind this project cannot afford.
 *
 * Two conversions matter and are done in one place each:
 *
 * - Heights are JS `number`. Postgres BIGINT arrives as a string.
 * - Luna amounts are `bigint`, never `number`. NUMERIC arrives as a string,
 *   which is lossless; going via `Number` would not be.
 */

import {
  LAUNCH_PRICES,
  isProfileName,
  parseAddress,
  type Address,
  type NameRecord,
  type NameStatus,
  type NnsState,
  type Obligation,
  type ObligationKind,
  type Offer,
  type PendingGovernance,
  type PendingRecovery,
  type PendingTransfer,
  type PendingUnreserve,
  type Prices,
  type ProfileName,
} from '@nns/core'

export class RowError extends Error {
  override readonly name = 'RowError'
}

// ── Scalar conversions ──────────────────────────────────────────────────────

/** Postgres hands BIGINT back as a string; the chain is nowhere near 2^53. */
export function toHeight(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' || typeof value === 'bigint') {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  throw new RowError(`${field}: ${JSON.stringify(value)} is not a height`)
}

/** NUMERIC arrives as a decimal string. Never route a luna amount via Number. */
export function toLuna(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  // A JS number is accepted only where it is provably lossless, so a driver
  // configured to parse NUMERIC cannot silently round a large amount.
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  throw new RowError(`${field}: ${JSON.stringify(value)} is not a luna amount`)
}

function toAddress(value: unknown, field: string): Address {
  if (typeof value !== 'string') throw new RowError(`${field}: ${JSON.stringify(value)} is not an address`)
  try {
    // CHAR(36) pads on read in some drivers; the compact form has no spaces.
    return parseAddress(value.trim())
  } catch (cause) {
    throw new RowError(`${field}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

function toText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new RowError(`${field}: ${JSON.stringify(value)} is not text`)
  return value
}

// ── Row shapes ──────────────────────────────────────────────────────────────

export type NameRow = {
  name: string
  owner: string
  target: string
  expiry: number
  status: string
  recovery: string | null
  host: string
}

// These are type aliases rather than interfaces on purpose: only an alias
// gets the implicit index signature that lets a row be passed to the generic
// insert helper without a cast.
export type PendingKind = 'TRANSFER' | 'RECOVERY' | 'OFFER' | 'GOVERNANCE' | 'UNRESERVE'

export type PendingRow = {
  kind: PendingKind
  name: string
  effective_height: number | null
  new_owner: string | null
  via_recovery: boolean | null
  recovery: string | null
  // UNRESERVE. NULL is meaningful: a release, not an award (§6 U, r17).
  recipient: string | null
  seller: string | null
  price: string | null
  opened_height: number | null
  expiry_height: number | null
  fee_standard: string | null
  fee_long: string | null
  commission_bp: string | null
}

export type ParamsRow = {
  fee_standard: string
  fee_long: string
  commission_bp: string
  last_governance_height: number | null
  state_height: number
  next_due_height: number | null
  // NULL is mainnet — the unmarked case, exactly as on `NnsState.profile`,
  // so a pre-profile database reads back unchanged, object shape included.
  profile: string | null
}

export type SettlementRow = {
  ref_height: number
  ref_tx_index: number
  ordinal: number
  kind: ObligationKind
  owed_by: string
  owed_to: string
  amount: string
}

export type LogRow = {
  block_height: number
  tx_index: number
  tx_hash: string
  sender: string
  recipient: string
  value: string
  data: string
  verdict: string
}

export interface StateRows {
  names: NameRow[]
  pending: PendingRow[]
  unreserved: string[]
  settlements: SettlementRow[]
  params: ParamsRow
}

// ── State → rows ────────────────────────────────────────────────────────────

const emptyPending = {
  effective_height: null,
  new_owner: null,
  via_recovery: null,
  recovery: null,
  recipient: null,
  seller: null,
  price: null,
  opened_height: null,
  expiry_height: null,
  fee_standard: null,
  fee_long: null,
  commission_bp: null,
} as const

export function nameRows(state: NnsState): NameRow[] {
  return [...state.names.values()].map((record) => ({
    name: record.name,
    owner: record.owner,
    target: record.target,
    expiry: record.expiry,
    status: record.status,
    recovery: record.recovery,
    host: record.host,
  }))
}

export function pendingRows(state: NnsState): PendingRow[] {
  const rows: PendingRow[] = []
  for (const item of state.transfers.values()) {
    rows.push({
      ...emptyPending,
      kind: 'TRANSFER',
      name: item.name,
      effective_height: item.effectiveHeight,
      new_owner: item.newOwner,
      via_recovery: item.viaRecovery,
    })
  }
  for (const item of state.recoveries.values()) {
    rows.push({
      ...emptyPending,
      kind: 'RECOVERY',
      name: item.name,
      effective_height: item.effectiveHeight,
      // NULL here is a value, not an absence: it is a clearing `R` (§6 R).
      recovery: item.recovery,
    })
  }
  for (const item of state.offers.values()) {
    rows.push({
      ...emptyPending,
      kind: 'OFFER',
      name: item.name,
      seller: item.seller,
      price: item.price.toString(10),
      opened_height: item.openedHeight,
      expiry_height: item.expiryHeight,
    })
  }
  if (state.pendingGovernance !== null) {
    rows.push({
      ...emptyPending,
      kind: 'GOVERNANCE',
      name: '',
      effective_height: state.pendingGovernance.effectiveHeight,
      fee_standard: state.pendingGovernance.prices.feeStandard.toString(10),
      fee_long: state.pendingGovernance.prices.feeLong.toString(10),
      commission_bp: state.pendingGovernance.prices.commissionBp.toString(10),
    })
  }
  for (const item of state.pendingUnreserve.values()) {
    rows.push({
      ...emptyPending,
      kind: 'UNRESERVE',
      name: item.name,
      // NULL is a release; an address is the awardee (§6 U, r17). §8.1
      // commits this, so losing it across a restart would move the root.
      recipient: item.recipient,
      effective_height: item.effectiveHeight,
    })
  }
  return rows
}

export function settlementRows(state: NnsState): SettlementRow[] {
  const rows: SettlementRow[] = []
  for (const obligations of state.outstanding.values()) {
    obligations.forEach((item, ordinal) => {
      rows.push({
        ref_height: item.ref.height,
        ref_tx_index: item.ref.txIndex,
        ordinal,
        kind: item.kind,
        owed_by: item.owedBy,
        owed_to: item.owedTo,
        amount: item.amount.toString(10),
      })
    })
  }
  return rows
}

export function paramsRow(state: NnsState): ParamsRow {
  return {
    fee_standard: state.prices.feeStandard.toString(10),
    fee_long: state.prices.feeLong.toString(10),
    commission_bp: state.prices.commissionBp.toString(10),
    last_governance_height: state.lastGovernanceHeight,
    state_height: state.height,
    // Infinity has no SQL spelling; NULL is "nothing scheduled".
    next_due_height: Number.isFinite(state.nextDueHeight) ? state.nextDueHeight : null,
    profile: state.profile ?? null,
  }
}

export function rowsOf(state: NnsState): StateRows {
  return {
    names: nameRows(state),
    pending: pendingRows(state),
    unreserved: [...state.unreserved],
    settlements: settlementRows(state),
    params: paramsRow(state),
  }
}

// ── Rows → state ────────────────────────────────────────────────────────────

function readName(row: NameRow): NameRecord {
  const status = toText(row.status, 'names.status')
  if (status !== 'REGISTERED' && status !== 'GRACE') {
    throw new RowError(`names.status: ${JSON.stringify(status)} is not a NameStatus`)
  }
  return {
    name: toText(row.name, 'names.name'),
    owner: toAddress(row.owner, 'names.owner'),
    target: toAddress(row.target, 'names.target'),
    expiry: toHeight(row.expiry, 'names.expiry'),
    status: status satisfies NameStatus,
    recovery: row.recovery === null ? null : toAddress(row.recovery, 'names.recovery'),
    host: toText(row.host, 'names.host'),
  }
}

function required<T>(value: T | null | undefined, field: string): T {
  if (value === null || value === undefined) throw new RowError(`${field} must not be null for this kind`)
  return value
}

/** NULL is mainnet; a name has to be one core knows, since it picks the constants. */
function toProfile(value: unknown): ProfileName | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && isProfileName(value)) return value
  throw new RowError(`params.profile: ${JSON.stringify(value)} is not a constants profile`)
}

export function stateFromRows(rows: StateRows): NnsState {
  const names = new Map<string, NameRecord>()
  for (const row of rows.names) {
    const record = readName(row)
    names.set(record.name, record)
  }

  const transfers = new Map<string, PendingTransfer>()
  const recoveries = new Map<string, PendingRecovery>()
  const offers = new Map<string, Offer>()
  const pendingUnreserve = new Map<string, PendingUnreserve>()
  let pendingGovernance: PendingGovernance | null = null

  for (const row of rows.pending) {
    const name = toText(row.name, 'pending.name')
    switch (row.kind) {
      case 'TRANSFER':
        transfers.set(name, {
          name,
          newOwner: toAddress(required(row.new_owner, 'pending.new_owner'), 'pending.new_owner'),
          effectiveHeight: toHeight(required(row.effective_height, 'pending.effective_height'), 'pending.effective_height'),
          viaRecovery: required(row.via_recovery, 'pending.via_recovery'),
        })
        break
      case 'RECOVERY':
        recoveries.set(name, {
          name,
          // NULL survives as null: a clearing `R` is not an absent row.
          recovery: row.recovery === null ? null : toAddress(row.recovery, 'pending.recovery'),
          effectiveHeight: toHeight(required(row.effective_height, 'pending.effective_height'), 'pending.effective_height'),
        })
        break
      case 'OFFER':
        offers.set(name, {
          name,
          seller: toAddress(required(row.seller, 'pending.seller'), 'pending.seller'),
          price: toLuna(required(row.price, 'pending.price'), 'pending.price'),
          openedHeight: toHeight(required(row.opened_height, 'pending.opened_height'), 'pending.opened_height'),
          expiryHeight: toHeight(required(row.expiry_height, 'pending.expiry_height'), 'pending.expiry_height'),
        })
        break
      case 'GOVERNANCE':
        if (pendingGovernance !== null) throw new RowError('pending: more than one GOVERNANCE row')
        pendingGovernance = {
          prices: {
            feeStandard: toLuna(required(row.fee_standard, 'pending.fee_standard'), 'pending.fee_standard'),
            feeLong: toLuna(required(row.fee_long, 'pending.fee_long'), 'pending.fee_long'),
            commissionBp: toLuna(required(row.commission_bp, 'pending.commission_bp'), 'pending.commission_bp'),
          },
          effectiveHeight: toHeight(required(row.effective_height, 'pending.effective_height'), 'pending.effective_height'),
        }
        break
      case 'UNRESERVE':
        pendingUnreserve.set(name, {
          name,
          // NULL survives as null: a release is not an award to nobody.
          recipient: row.recipient === null ? null : toAddress(row.recipient, 'pending.recipient'),
          effectiveHeight: toHeight(required(row.effective_height, 'pending.effective_height'), 'pending.effective_height'),
        })
        break
      default:
        throw new RowError(`pending.kind: ${JSON.stringify(row.kind)} is not a pending kind`)
    }
  }

  // Grouped by the transaction that owes them, ordered by `ordinal` — the
  // order within a transaction is significant, and a set would lose it.
  const outstanding = new Map<string, Obligation[]>()
  for (const row of [...rows.settlements].sort((a, b) => a.ordinal - b.ordinal)) {
    const height = toHeight(row.ref_height, 'settlements.ref_height')
    const txIndex = toHeight(row.ref_tx_index, 'settlements.ref_tx_index')
    const key = `${height}:${txIndex}`
    const list = outstanding.get(key) ?? []
    list.push({
      ref: { height, txIndex },
      kind: row.kind,
      owedBy: toAddress(row.owed_by, 'settlements.owed_by'),
      owedTo: toAddress(row.owed_to, 'settlements.owed_to'),
      amount: toLuna(row.amount, 'settlements.amount'),
    })
    outstanding.set(key, list)
  }

  const prices: Prices = {
    feeStandard: toLuna(rows.params.fee_standard, 'params.fee_standard'),
    feeLong: toLuna(rows.params.fee_long, 'params.fee_long'),
    commissionBp: toLuna(rows.params.commission_bp, 'params.commission_bp'),
  }

  const profile = toProfile(rows.params.profile)

  return Object.freeze({
    // Mainnet stays the unmarked case: no property, exactly as `initialState`
    // builds it — a state reloaded from a pre-profile database is
    // indistinguishable from one that never restarted. A stamped profile is
    // what `constantsOf` reads, so losing it here would advance a fast state
    // under mainnet timings after the restart and nowhere else.
    ...(profile === null ? {} : { profile }),
    height: toHeight(rows.params.state_height, 'params.state_height'),
    names,
    transfers,
    recoveries,
    offers,
    prices,
    pendingGovernance,
    lastGovernanceHeight:
      rows.params.last_governance_height === null
        ? null
        : toHeight(rows.params.last_governance_height, 'params.last_governance_height'),
    unreserved: new Set(rows.unreserved.map((name) => toText(name, 'unreserved.name'))),
    pendingUnreserve,
    outstanding: outstanding as ReadonlyMap<string, readonly Obligation[]>,
    nextDueHeight:
      rows.params.next_due_height === null
        ? Number.POSITIVE_INFINITY
        : toHeight(rows.params.next_due_height, 'params.next_due_height'),
  })
}

/** Launch prices, for the first `params` row. */
export const LAUNCH_PARAMS = LAUNCH_PRICES
