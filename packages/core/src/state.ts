/**
 * Registry state — the thing every implementation must agree on byte for byte.
 *
 * What is in here is fixed by §8.1: the name records that become Merkle
 * leaves, plus the two pieces the spec adds explicitly — "the **active prices
 * and commission rate**" and "the **pending set** — in-flight `X`, open
 * offers, open auctions and any pending `P`, each with its effective, expiry
 * or end height" — because both are consensus-relevant and independent
 * replays diverge without them.
 *
 * Settlement obligations are also tracked. They are *not* part of the §8.1
 * commitment: §6 `M` says settled-versus-owed is computable from the log, so
 * they are a convenience for the settlement service and the burn dashboard,
 * and `merkle.ts` must not read them.
 */

import type { Address } from './address.js'
import { CONSTANTS } from './constants.js'
import { isReservedName } from './name.js'

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
  /** Delegate resolver host, `''` when none (§6 `D`). */
  readonly host: string
  /**
   * EVM address the owner declared, lowercase `0x`-hex, `''` when none
   * (§6 `E`). One record covers every EVM chain; §8.1 commits it as raw
   * 20 bytes, zero when unset.
   */
  readonly evm: string
}

/** An `X` awaiting its `XFER_TIMELOCK` (§6 `X`). */
export interface PendingTransfer {
  readonly name: string
  readonly newOwner: Address
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

/**
 * An open `A` (§6 `A`, r28).
 *
 * `seller` is the owner who opened it, or `TREASURY_ADDRESS` for an admin
 * auction of a name still held in `RESERVED_NAMES` — the two are told apart
 * by whether the name has a record. `endHeight` moves: every successful bid
 * inside `AUCTION_EXTENSION` of it pushes it to `bid + AUCTION_EXTENSION`.
 * `bidder` is `null` and `bid` is `0n` until the first bid reaches the
 * starting price; from then on the marketplace holds exactly this one bid, every
 * outbid one having been refunded the moment it was beaten.
 *
 * `bidRef` is the transaction the standing bid arrived in — the `(height,
 * tx_index)` the close's two `M` legs will name. It is settlement identity,
 * so §8.1 commits everything here **except** it, on the same terms as the
 * obligations themselves.
 */
export interface Auction {
  readonly name: string
  readonly seller: Address
  readonly startingPrice: bigint
  readonly endHeight: number
  readonly bidder: Address | null
  readonly bid: bigint
  readonly bidRef: TxRef | null
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

/*
 * `PendingUnreserve` lived here through r21, with a `recipient` and an
 * `effectiveHeight`, committed under §8.1 tag `0x09`. r22 made a `U` execute in
 * the block it lands in (§6 `U`), so there is no pending form to hold and the
 * tag is retired rather than reused — the same treatment r20 gave `0x06`. Do
 * not reintroduce it without reintroducing the notice window, and read §6 `U`'s
 * frontrunner argument first.
 */

/**
 * §3 `MIN_PRICE` — the floor on an `O` price and an `A` starting price (§6 `O`, §6 `A`).
 *
 * Defined **as `FEE_LONG`**, not as a luna amount, so it tracks the NIM price
 * through §10.6 instead of going stale. That makes it a *governed* value: it is
 * whatever `FEE_LONG` is in effect at the message's own block height, which is
 * exactly what `state.prices` holds once `advanceTo` has run for that height.
 * Reading it from `constants.ts` instead would be right until the first `P`
 * moves `FEE_LONG` and wrong, silently, forever after.
 */
export const minPrice = (prices: Prices): bigint => prices.feeLong

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
  readonly offers: ReadonlyMap<string, Offer>
  /** Open auctions, keyed by name (§6 `A`, r28). Committed under tag `0x0B`. */
  readonly auctions: ReadonlyMap<string, Auction>
  readonly prices: Prices
  readonly pendingGovernance: PendingGovernance | null
  /**
   * Height of the last accepted `P`. **Informational, and consensus-irrelevant
   * since the `PRICE_MIN_INTERVAL` bound was removed** (§10.6): no rule reads
   * it, §8.1 commits it nowhere, and two indexers disagreeing about it derive
   * identical roots. It is kept because the API and the admin CLI answer "when
   * did governance last act" from it, and it is deterministic either way.
   *
   * While the frequency bound existed this field was the one consensus input
   * that decided a verdict without appearing in any commitment — the r16 `0x0A`
   * shape of gap. Removing the bound closed it from the other side.
   */
  readonly lastGovernanceHeight: number | null
  /**
   * Names taken out of `RESERVED_NAMES` by a `U` (§6 `U`), released or
   * awarded alike. A `U` fires in its own block, so this is the whole of what
   * one leaves behind — there is no pending counterpart.
   */
  readonly unreserved: ReadonlySet<string>
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
export function initialState(): NnsState {
  return Object.freeze({
    height: CONSTANTS.LAUNCH_HEIGHT,
    names: new Map<string, NameRecord>(),
    transfers: new Map<string, PendingTransfer>(),
    offers: new Map<string, Offer>(),
    auctions: new Map<string, Auction>(),
    prices: LAUNCH_PRICES,
    pendingGovernance: null,
    lastGovernanceHeight: null,
    unreserved: new Set<string>(),
    outstanding: new Map<string, readonly Obligation[]>(),
    nextDueHeight: Number.POSITIVE_INFINITY,
  })
}

/**
 * Whether a name is currently withheld: a `RESERVED_NAMES` member — on the
 * published list, or a 1–4 character name reserved by rule (§4.1) — and not
 * yet released by a `U` that has taken effect (§6 `U`).
 */
export const isReserved = (state: NnsState, name: string): boolean =>
  isReservedName(name) && !state.unreserved.has(name)

/** The name's record, or `null` when it is `AVAILABLE`. */
export const lookup = (state: NnsState, name: string): NameRecord | null => state.names.get(name) ?? null

/** A name resolves only while `REGISTERED`; during `GRACE` resolution is off (§7.3). */
export function resolve(state: NnsState, name: string): Address | null {
  const record = state.names.get(name)
  return record !== undefined && record.status === 'REGISTERED' ? record.target : null
}
