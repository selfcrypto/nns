/**
 * Registry state — the thing every implementation must agree on byte for byte.
 *
 * What is in here is fixed by §8.1: the name records that become Merkle
 * leaves, plus the two pieces the spec adds explicitly — "the **active prices
 * and commission rate**" and "the **pending set** — in-flight `X`/`R` and open
 * offers, each with its effective or expiry height" — because both are
 * consensus-relevant and independent replays diverge without them.
 *
 * Settlement obligations are also tracked. They are *not* part of the §8.1
 * commitment: §6 `M` says settled-versus-owed is computable from the log, so
 * they are a convenience for the settlement service and the burn dashboard,
 * and `merkle.ts` must not read them.
 */

import type { Address } from './address.js'
import type { NnsConfig } from './config.js'
import { CONSTANTS } from './constants.js'

/** §8.1 commits `0x00` for `REGISTERED` and `0x01` for `GRACE`. */
export type NameStatus = 'REGISTERED' | 'GRACE'

export interface NameRecord {
  readonly name: string
  readonly owner: Address
  /** Where the name resolves. Set to the owner on registration and on transfer. */
  readonly target: Address
  /** Height at which `REGISTERED` becomes `GRACE`. */
  readonly expiry: number
  readonly status: NameStatus
  /** `null` when unset — §8.1 encodes that as 20 zero bytes. */
  readonly recovery: Address | null
  /** Delegate resolver host, `''` when none (§6 `D`). */
  readonly host: string
}

/** An `X` awaiting its timelock (§6 `X`). */
export interface PendingTransfer {
  readonly name: string
  readonly newOwner: Address
  readonly effectiveHeight: number
  /** Sent by the recovery address, so it waits `RECOVERY_TIMELOCK`, not `XFER_TIMELOCK`. */
  readonly viaRecovery: boolean
}

/** An `R` awaiting its timelock. `recovery: null` is a clearing operation. */
export interface PendingRecovery {
  readonly name: string
  readonly recovery: Address | null
  readonly effectiveHeight: number
}

/** An open `O` (§6 `O`). */
export interface Offer {
  readonly name: string
  readonly seller: Address
  readonly price: bigint
  readonly openedHeight: number
  /** `openedHeight + OFFER_MAX_LIFETIME`. */
  readonly expiryHeight: number
}

/** The three governable parameters, always moved together (§6 `P`). */
export interface Prices {
  readonly feeStandard: bigint
  readonly feeLong: bigint
  readonly commissionBp: bigint
}

export interface PendingGovernance {
  readonly prices: Prices
  readonly effectiveHeight: number
}

/** Canonical identity of a transaction: `(block height, zero-based index)`. */
export interface TxRef {
  readonly height: number
  readonly txIndex: number
}

export const refKey = (ref: TxRef): string => `${ref.height}:${ref.txIndex}`

export type ObligationKind = 'REFUND' | 'SALE_PROCEEDS' | 'COMMISSION'

/**
 * Money owed as a result of a message, discharged by an `M` (§6 `M`, §7.4).
 * The `ref` is the transaction that created the debt.
 */
export interface Obligation {
  readonly ref: TxRef
  readonly kind: ObligationKind
  readonly owedBy: Address
  readonly owedTo: Address
  readonly amount: bigint
}

export interface NnsState {
  /** Highest height whose scheduled effects have been applied. */
  readonly height: number
  readonly names: ReadonlyMap<string, NameRecord>
  readonly transfers: ReadonlyMap<string, PendingTransfer>
  readonly recoveries: ReadonlyMap<string, PendingRecovery>
  readonly offers: ReadonlyMap<string, Offer>
  readonly prices: Prices
  readonly pendingGovernance: PendingGovernance | null
  /** Height of the last accepted `P`, for the `PRICE_MIN_INTERVAL` check. */
  readonly lastGovernanceHeight: number | null
  /** Names released from `RESERVED_NAMES` by a `U` that has taken effect. */
  readonly unreserved: ReadonlySet<string>
  /** `U` messages awaiting their `effective_height`, keyed by name. */
  readonly pendingUnreserve: ReadonlyMap<string, { readonly name: string; readonly effectiveHeight: number }>
  /** Unsettled obligations, keyed by {@link refKey} of the transaction owing them. */
  readonly outstanding: ReadonlyMap<string, readonly Obligation[]>
  /**
   * Lowest height at which any scheduled effect is due, or `Infinity`.
   *
   * A lower bound, not an exact value: it is tightened on insert and
   * recomputed whenever effects fire. Being too low only costs a scan that
   * finds nothing, so it can never change the resulting state — which is why
   * it is safe to carry a derived value in consensus state at all.
   */
  readonly nextDueHeight: number
}

/** Launch prices come from §3; governance moves them from there (§10.6). */
export const LAUNCH_PRICES: Prices = Object.freeze({
  feeStandard: CONSTANTS.FEE_STANDARD,
  feeLong: CONSTANTS.FEE_LONG,
  commissionBp: CONSTANTS.COMMISSION_RATE,
})

/** Empty state at `LAUNCH_HEIGHT` (§7.2 step 1). */
export function initialState(config: NnsConfig): NnsState {
  return Object.freeze({
    height: config.launchHeight,
    names: new Map<string, NameRecord>(),
    transfers: new Map<string, PendingTransfer>(),
    recoveries: new Map<string, PendingRecovery>(),
    offers: new Map<string, Offer>(),
    prices: LAUNCH_PRICES,
    pendingGovernance: null,
    lastGovernanceHeight: null,
    unreserved: new Set<string>(),
    pendingUnreserve: new Map<string, { name: string; effectiveHeight: number }>(),
    outstanding: new Map<string, readonly Obligation[]>(),
    nextDueHeight: Number.POSITIVE_INFINITY,
  })
}

/**
 * Whether a name is currently withheld: on the published `RESERVED_NAMES` list
 * and not yet released by a `U` that has taken effect (§4.1, §6 `U`).
 */
export const isReserved = (state: NnsState, config: NnsConfig, name: string): boolean =>
  config.reservedNames.has(name) && !state.unreserved.has(name)

/** The name's record, or `null` when it is `AVAILABLE`. */
export const lookup = (state: NnsState, name: string): NameRecord | null => state.names.get(name) ?? null

/** A name resolves only while `REGISTERED`; during `GRACE` resolution is off (§7.3). */
export function resolve(state: NnsState, name: string): Address | null {
  const record = state.names.get(name)
  return record !== undefined && record.status === 'REGISTERED' ? record.target : null
}
