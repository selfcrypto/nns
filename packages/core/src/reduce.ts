/**
 * The reducer — spec §7.
 *
 * `reduce(state, tx, config)` is the whole of NNS's interpretation layer: the
 * chain is an ordered, finalised message bus, and this function is what turns
 * that stream into `name → address`. Two implementations that disagree here
 * produce different Merkle roots and no error anywhere, so every branch below
 * cites the clause it implements.
 *
 * Order of operations, and the order is load-bearing:
 *
 * 1. §7.5 discards, **before a message is even parsed**.
 * 2. {@link advanceTo} the transaction's height, applying every scheduled
 *    effect that has come due.
 * 3. Parse, check §5.3 routing, then the §7.3 state machine and §7.4 verdicts.
 *
 * ## Auctions (r28)
 *
 * Through r27 an `A` was parsed, logged and forfeited `AUCTION_NOT_IN_V1`, by
 * protocol version rather than by omission, with activation deferred to "a
 * stated height" under a later spec. Before launch that height is simply
 * `LAUNCH_HEIGHT`, and every piece the clause leaned on already existed here —
 * the height-driven effect engine, the typed pending set, obligations
 * discharged by `M` — so r28 makes `A` a v1 rule. The token is gone from the
 * vocabulary: no rule on any deployment can produce it now (§7.4's own
 * maintenance rule). `AUCTION_OPEN` took its slot.
 *
 * A bid is a `B` whose name has an open auction; a close is a height effect
 * (`ORDER.AUCTION_CLOSE`), so the two legs it owes are the one place an
 * obligation is created with no verdict to carry it — `outstanding` is the
 * record, and a settlement replay reads it rather than the verdict stream.
 */

import { type Address, addressEquals } from './address.js'
import { effectiveSender } from './attribution.js'
import { BURN_ADDRESS, type Message, parse } from './codec.js'
import type { NnsConfig } from './config.js'
import { CONSTANTS, feeMultiplier } from './constants.js'
import { isReservedName, validateHost, validateName } from './name.js'
import {
  type Auction,
  type NameRecord,
  type NnsState,
  type Obligation,
  type Offer,
  type PendingGovernance,
  type PendingTransfer,
  type Prices,
  type TxRef,
  isReserved,
  minPrice,
  refKey,
} from './state.js'

export class ReducerError extends Error {
  override readonly name = 'ReducerError'
}

// ── Input ───────────────────────────────────────────────────────────────────

/**
 * One transaction, as the indexer reads it from the RPC.
 *
 * `txIndex` is the **zero-based rank** in canonical order within the block —
 * `(blockNumber ascending, transaction hash ascending, bytewise)` over the
 * block's `NNS1`-prefixed transactions, before any §7.5 discard (§5.2, r27).
 * `rankMessages` in `ordering.ts` derives it; this type only carries it.
 */
export interface ChainTransaction {
  readonly blockNumber: number
  readonly txIndex: number
  readonly hash: string
  readonly sender: Address
  readonly recipient: Address
  readonly value: bigint
  /** Hex, as the RPC returns it. The field is `recipientData`, not `data`. */
  readonly recipientData: string
  /** Albatross includes failed transactions in blocks. `false` means discard. */
  readonly executionResult: boolean
  readonly networkId: number
  /** Reward transactions and inherents, which must not be counted in ordering. */
  readonly isReward?: boolean
  /**
   * §7.2 attribution (r25): the RPC's `fromType`, and the transaction proof,
   * hex. Absent fields mean account attribution — every non-contract caller
   * is unchanged, and an unrecognised proof shape behaves the same way.
   */
  readonly senderType?: number
  readonly proof?: string
}

// ── Verdicts ────────────────────────────────────────────────────────────────

/** §7.5. These earn **no log line** — §7.6 logs only what survives §7.5. */
export type IgnoredReason =
  | 'BEFORE_LAUNCH'
  | 'WRONG_NETWORK'
  | 'FAILED_EXECUTION'
  | 'REWARD_TRANSACTION'
  | 'NOT_NNS1'

/** §7.4 forfeit column — value not recoverable through the protocol. */
export type ForfeitReason =
  | 'UNKNOWN_TYPE'
  | 'OVER_LENGTH'
  | 'MALFORMED_PAYLOAD'
  | 'WRONG_RECIPIENT'
  | 'INVALID_RECIPIENT'
  | 'WRONG_SENDER'
  | 'INVALID_NAME'
  | 'RESERVED_NAME'
  | 'NAME_IN_GRACE'
  | 'NAME_NOT_REGISTERED'
  | 'NAME_NOT_FOUND'
  | 'NOT_OWNER'
  | 'INVALID_HOST'
  | 'NOT_ADMIN'
  | 'GOVERNANCE_BOUND_VIOLATED'
  | 'INSUFFICIENT_NOTICE'
  | 'NAME_NOT_RESERVED'
  | 'NAME_NOT_AVAILABLE'
  | 'NOTHING_TO_CANCEL'
  | 'BELOW_REFUND_FLOOR'
  | 'BELOW_MIN_PRICE'
  | 'AUCTION_OPEN'
  | 'OFFER_OPEN'
  | 'TRANSFER_PENDING'
  | 'AUCTION_BEYOND_TERM'

/**
 * §7.4 refundable column. Three are losses caused by concurrency; the fourth,
 * `INSUFFICIENT_VALUE` (r29), is money the treasury received for nothing —
 * an honest client underpays when a `P` activates while its `G` sits in the
 * mempool, and the protocol keeps nothing it did not earn.
 */
export type RefundReason = 'LOST_REGISTRATION_RACE' | 'OFFER_NOT_OPEN' | 'WRONG_PRICE' | 'INSUFFICIENT_VALUE'

export type Verdict =
  | { readonly kind: 'IGNORED'; readonly reason: IgnoredReason }
  | { readonly kind: 'OK'; readonly obligations: readonly Obligation[] }
  | { readonly kind: 'FORFEIT'; readonly reason: ForfeitReason }
  | { readonly kind: 'REFUND'; readonly reason: RefundReason; readonly obligations: readonly Obligation[] }

export interface ReduceResult {
  readonly state: NnsState
  readonly verdict: Verdict
}

const ignored = (reason: IgnoredReason): Verdict => ({ kind: 'IGNORED', reason })
const forfeit = (reason: ForfeitReason): Verdict => ({ kind: 'FORFEIT', reason })
const ok = (obligations: readonly Obligation[] = []): Verdict => ({ kind: 'OK', obligations })

// ── Draft ───────────────────────────────────────────────────────────────────

interface Draft {
  height: number
  names: Map<string, NameRecord>
  transfers: Map<string, PendingTransfer>
  offers: Map<string, Offer>
  auctions: Map<string, Auction>
  prices: Prices
  pendingGovernance: PendingGovernance | null
  lastGovernanceHeight: number | null
  unreserved: Set<string>
  outstanding: Map<string, readonly Obligation[]>
  nextDueHeight: number
}

const draftOf = (state: NnsState): Draft => ({
  height: state.height,
  names: new Map(state.names),
  transfers: new Map(state.transfers),
  offers: new Map(state.offers),
  auctions: new Map(state.auctions),
  prices: state.prices,
  pendingGovernance: state.pendingGovernance,
  lastGovernanceHeight: state.lastGovernanceHeight,
  unreserved: new Set(state.unreserved),
  outstanding: new Map(state.outstanding),
  nextDueHeight: state.nextDueHeight,
})

const freeze = (draft: Draft): NnsState => Object.freeze({ ...draft })

/** Tighten the due-height lower bound. Never widens it — see {@link NnsState.nextDueHeight}. */
const schedule = (draft: Draft, height: number): void => {
  if (height < draft.nextDueHeight) draft.nextDueHeight = height
}

function computeNextDue(draft: Draft): number {
  let next = Number.POSITIVE_INFINITY
  const consider = (height: number): void => {
    if (height > draft.height && height < next) next = height
  }
  if (draft.pendingGovernance !== null) consider(draft.pendingGovernance.effectiveHeight)
  for (const item of draft.transfers.values()) consider(item.effectiveHeight)
  for (const item of draft.offers.values()) consider(item.expiryHeight)
  for (const item of draft.auctions.values()) consider(item.endHeight)
  for (const record of draft.names.values()) {
    if (record.status === 'REGISTERED') consider(record.expiry)
    else consider(record.expiry + CONSTANTS.GRACE_PERIOD)
  }
  return next
}

// ── Obligations ─────────────────────────────────────────────────────────────

const obligation = (
  ref: TxRef,
  kind: Obligation['kind'],
  owedBy: Address,
  owedTo: Address,
  amount: bigint,
): Obligation => Object.freeze({ ref, kind, owedBy, owedTo, amount })

/**
 * Record a debt directly in the draft. {@link reduce} does this for the legs a
 * verdict carries; the height-driven effects — an auction closing, or being
 * cancelled by the grace reset — have no verdict, so they write here.
 */
function owe(draft: Draft, item: Obligation): void {
  const key = refKey(item.ref)
  draft.outstanding.set(key, [...(draft.outstanding.get(key) ?? []), item])
}

// ── §7.3 dependent-state resets ─────────────────────────────────────────────

/**
 * §7.3: a name has at most one pending operation — a transfer, a sale or an
 * auction. A message of a *different* kind refuses while one stands, with
 * the token naming what does; a message of the *same* kind replaces it (a
 * second `X` retargets and restarts the timelock, a second `O` reprices),
 * unless it holds bids — an auction is never replaced, and a second `A`
 * forfeits `AUCTION_OPEN` like everything else. `K` clears a transfer or a
 * sale at any height. Nothing of one kind ever voids another: r28's `A`
 * voiding `O` and `X`, and the first r30 cut's `O` voiding `X`, are gone.
 * Only one map can hold the name, so the order here is unobservable and
 * pinned for the §7.4 table alone.
 */
function pendingOn(state: NnsState, name: string): 'AUCTION_OPEN' | 'OFFER_OPEN' | 'TRANSFER_PENDING' | null {
  if (state.auctions.has(name)) return 'AUCTION_OPEN'
  if (state.offers.has(name)) return 'OFFER_OPEN'
  if (state.transfers.has(name)) return 'TRANSFER_PENDING'
  return null
}

/**
 * §7.3: on a transfer taking effect (`X` after its timelock, `B`, or an
 * auction closing), owner and target both become the new owner, the EVM
 * address and the delegate host are cleared, open offers are cancelled, and
 * any pending `X` is void.
 *
 * A clean slate is the safe default — in particular the old target must not
 * keep receiving funds sent to the name, and the old owner's EVM key must
 * not keep answering for it — and the new owner reconfigures explicitly.
 *
 * Nothing can stand beside a pending `X` (`pendingOn`), so the deletes below
 * are the slate-wiping this comment describes on the `B` and close paths, and
 * no-ops on the timelock path.
 */
function applyTransfer(draft: Draft, name: string, newOwner: Address): void {
  const record = draft.names.get(name)
  if (record === undefined) return
  draft.names.set(name, { ...record, owner: newOwner, target: newOwner, host: '', evm: '' })
  draft.transfers.delete(name)
  draft.offers.delete(name)
  draft.auctions.delete(name)
}

/**
 * §6 `A`: cancel an open auction, refunding the standing bid if there is one.
 * The refund is keyed by the bid's own ref, like every other refund of a `B`.
 */
function cancelAuction(draft: Draft, name: string): void {
  const auction = draft.auctions.get(name)
  if (auction === undefined) return
  draft.auctions.delete(name)
  if (auction.bidder === null || auction.bidRef === null) return
  owe(draft, obligation(auction.bidRef, 'REFUND', CONSTANTS.MARKETPLACE_ADDRESS, auction.bidder, auction.bid))
}

/**
 * §7.3 on entering `GRACE`: the delegate host is cleared — a lapsed name
 * cannot keep answering for its subdomains — and open offers, any pending
 * `X` and any open auction are cancelled (the standing bid refunded). The EVM
 * address persists, like `owner` and `target`, so a grace-then-renew round
 * trip does not force the owner to re-declare it.
 */
function enterGrace(draft: Draft, name: string): void {
  const record = draft.names.get(name)
  if (record === undefined) return
  draft.names.set(name, { ...record, status: 'GRACE', host: '' })
  draft.transfers.delete(name)
  draft.offers.delete(name)
  cancelAuction(draft, name)
  schedule(draft, record.expiry + CONSTANTS.GRACE_PERIOD)
}

/** §7.3 on falling to `AVAILABLE`: all state for the name is cleared. */
function release(draft: Draft, name: string): void {
  draft.names.delete(name)
  draft.transfers.delete(name)
  draft.offers.delete(name)
  // Already cancelled on entering GRACE; nothing can reopen one on a grace name.
  draft.auctions.delete(name)
}

/**
 * §6 `A`: the least a bid must carry — the starting price until one has met it,
 * then the standing bid plus `AUCTION_MIN_INCREMENT` of itself, floored.
 * `MIN_PRICE` on the starting price is what keeps the increment from rounding to 0.
 */
export const requiredBid = (auction: Auction): bigint =>
  auction.bidder === null ? auction.startingPrice : auction.bid + commissionOn(auction.bid, CONSTANTS.AUCTION_MIN_INCREMENT_BP)

/**
 * §6 `A` close: with a standing bid the name changes hands and two legs are
 * owed against the winning bid's ref — proceeds to the seller less commission
 * at the rate active at the close height, and the commission to the treasury.
 * An admin auction of a still-reserved name creates the registration instead
 * of transferring one, on `U`'s award terms, and the name enters the
 * unreserved set. With no standing bid the auction simply ends.
 */
function closeAuction(draft: Draft, auction: Auction, height: number): void {
  draft.auctions.delete(auction.name)
  if (auction.bidder === null || auction.bidRef === null) return

  if (draft.names.has(auction.name)) {
    applyTransfer(draft, auction.name, auction.bidder)
  } else {
    draft.unreserved.add(auction.name)
    const expiry = height + CONSTANTS.TERM_LENGTH
    draft.names.set(auction.name, {
      name: auction.name,
      owner: auction.bidder,
      target: auction.bidder,
      expiry,
      status: 'REGISTERED',
      host: '',
      evm: '',
    })
    schedule(draft, expiry)
  }

  const commission = commissionOn(auction.bid, draft.prices.commissionBp)
  owe(draft, obligation(auction.bidRef, 'SALE_PROCEEDS', CONSTANTS.MARKETPLACE_ADDRESS, auction.seller, auction.bid - commission))
  owe(draft, obligation(auction.bidRef, 'COMMISSION', CONSTANTS.MARKETPLACE_ADDRESS, CONSTANTS.TREASURY_ADDRESS, commission))
}

// ── Height-driven effects ───────────────────────────────────────────────────

/**
 * Categories of scheduled effect, in the order they fire when several come due
 * at the same height. **This list is §7.3's, in §7.3's order** — governance
 * activation, maturing `X`, auction close, expiry to `GRACE`, grace release to
 * `AVAILABLE`, offer expiry — with ties inside a category broken bytewise by
 * name.
 *
 * The whole batch fires **before that block's transactions**: {@link reduce}
 * calls {@link advanceTo} for `tx.blockNumber` before it parses anything, so a
 * `P` effective at height H has already moved the prices when H's own
 * registrations are priced.
 *
 * The case that actually diverges is `TRANSFER` against `EXPIRE` at the same height: a
 * name whose expiry falls exactly on a maturing `X`. Transfer first hands the
 * name to the new owner and *then* moves it to `GRACE`, so the new owner holds
 * a renewable name. Expire first cancels the pending transfer as part of the
 * §7.3 grace reset, and the old owner keeps it. Both are defensible; they are
 * not the same state, and two implementations picking differently fork.
 *
 * Transfer is placed first because the transfer was scheduled before the
 * expiry came due, and because §7.3's grace reset exists to stop a lapsed name
 * answering for subdomains — not to void a transfer already in flight.
 *
 * Proposed here first, then ratified into §7.3 by spec r15. r20 removed the
 * `RECOVERY` step along with `R` itself, and r22 the `UNRESERVE` step along
 * with the pending `U`; the remaining steps keep their relative order, which is
 * the only thing consensus depends on. `GOVERNANCE` is now the only
 * governance effect driven by height at all.
 *
 * r28 added `AUCTION_CLOSE`. It sits after `GOVERNANCE` so the commission a
 * close owes is at the rate active at the close height, exactly as a `B` in
 * that block would be charged — and, since 2026-09-03, *after* the expiry
 * and the grace release: an `A` may not open past the name's term
 * (`AUCTION_BEYOND_TERM`), so a close and an expiry meet only when an
 * extension pushed the end exactly onto the expiry, and then the seller who
 * let the term lapse keeps a grace name while the bidder is refunded. The
 * alternative handed the winner a name already in grace. A close can never
 * collide with a transfer on one name — an open auction excludes `X` (§6 `A`).
 */
const ORDER = {
  GOVERNANCE: 0,
  TRANSFER: 1,
  EXPIRE: 2,
  RELEASE: 3,
  AUCTION_CLOSE: 4,
  OFFER_EXPIRE: 5,
} as const

interface DueEffect {
  readonly height: number
  readonly order: number
  readonly key: string
  readonly apply: (draft: Draft) => void
}

function collectDue(draft: Draft, upto: number): DueEffect[] {
  const due: DueEffect[] = []

  const governance = draft.pendingGovernance
  if (governance !== null && governance.effectiveHeight <= upto) {
    due.push({
      height: governance.effectiveHeight,
      order: ORDER.GOVERNANCE,
      key: '',
      apply: (d) => {
        if (d.pendingGovernance === null || d.pendingGovernance.effectiveHeight > upto) return
        d.prices = d.pendingGovernance.prices
        d.pendingGovernance = null
      },
    })
  }

  // An unreserve-activation step sat here through r21, second in ORDER. r22
  // made a `U` execute in its landing block (§6 `U`), so nothing about a
  // release or an award is ever scheduled and there is no height to fire.

  for (const item of draft.transfers.values()) {
    if (item.effectiveHeight > upto) continue
    due.push({
      height: item.effectiveHeight,
      order: ORDER.TRANSFER,
      key: item.name,
      apply: (d) => {
        const pending = d.transfers.get(item.name)
        if (pending === undefined || pending.effectiveHeight > upto) return
        applyTransfer(d, item.name, pending.newOwner)
      },
    })
  }

  for (const item of draft.auctions.values()) {
    if (item.endHeight > upto) continue
    due.push({
      height: item.endHeight,
      order: ORDER.AUCTION_CLOSE,
      key: item.name,
      apply: (d) => {
        const auction = d.auctions.get(item.name)
        if (auction === undefined || auction.endHeight > upto) return
        closeAuction(d, auction, auction.endHeight)
      },
    })
  }

  for (const record of draft.names.values()) {
    if (record.status === 'REGISTERED') {
      if (record.expiry <= upto) {
        due.push({
          height: record.expiry,
          order: ORDER.EXPIRE,
          key: record.name,
          apply: (d) => {
            const current = d.names.get(record.name)
            if (current === undefined || current.status !== 'REGISTERED' || current.expiry > upto) return
            enterGrace(d, record.name)
          },
        })
      }
    } else {
      const end = record.expiry + CONSTANTS.GRACE_PERIOD
      if (end <= upto) {
        due.push({
          height: end,
          order: ORDER.RELEASE,
          key: record.name,
          apply: (d) => {
            const current = d.names.get(record.name)
            if (current === undefined || current.status !== 'GRACE') return
            if (current.expiry + CONSTANTS.GRACE_PERIOD > upto) return
            release(d, record.name)
          },
        })
      }
    }
  }

  for (const item of draft.offers.values()) {
    if (item.expiryHeight > upto) continue
    due.push({
      height: item.expiryHeight,
      order: ORDER.OFFER_EXPIRE,
      key: item.name,
      apply: (d) => {
        const offer = d.offers.get(item.name)
        if (offer === undefined || offer.expiryHeight > upto) return
        d.offers.delete(item.name)
      },
    })
  }

  due.sort((a, b) => a.height - b.height || a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return due
}

/**
 * Apply every scheduled effect due at or before `height`, then set the state's
 * height.
 *
 * **The indexer must call this at every `CHECKPOINT_INTERVAL` boundary, not
 * only when a transaction arrives.** Expiry, grace release, timelock maturity
 * and governance activation are driven by height, not by messages — so a
 * checkpoint taken during a quiet stretch would otherwise commit a root
 * containing an expired name still marked `REGISTERED`.
 *
 * @throws {ReducerError} if asked to move backwards. Replay is forward-only.
 */
export function advanceTo(state: NnsState, height: number): NnsState {
  if (height < state.height) {
    throw new ReducerError(`cannot advance from height ${state.height} back to ${height}`)
  }
  if (height === state.height) return state
  if (height < state.nextDueHeight) return Object.freeze({ ...state, height })

  const draft = draftOf(state)
  // Applying one effect can bring another into range: a name can expire and
  // then leave grace inside a single advance, so this runs to a fixed point.
  // The longest chain in §7.3 is REGISTERED → GRACE → AVAILABLE, which is two
  // passes; the bound is deliberately loose and exists only so a future effect
  // that never clears its guard fails loudly instead of hanging.
  const MAX_PASSES = 8
  let passes = 0
  for (;;) {
    const due = collectDue(draft, height)
    if (due.length === 0) break
    if (++passes > MAX_PASSES) {
      throw new ReducerError(`scheduled effects did not converge at height ${height} after ${MAX_PASSES} passes`)
    }
    for (const effect of due) effect.apply(draft)
  }
  draft.height = height
  draft.nextDueHeight = computeNextDue(draft)
  return freeze(draft)
}

// ── Pricing ─────────────────────────────────────────────────────────────────

/**
 * The fee a `G` or `N` owes for a name at the prices currently in effect
 * (§10.1): `FEE_BASE × FEE_MULTIPLIERS[len(name)]`, and `LIFETIME_MULTIPLIER`
 * times that for a lifetime term (§10.4).
 *
 * Registrations are validated against the prices in effect at their own block
 * height (§10.6), which is exactly what `state.prices` holds once
 * {@link advanceTo} has run for that height. Length is read from the name
 * itself — the band is never declared on the wire (§6.1) — and a 1–4
 * character name is priced by its own band the moment it is registrable at
 * all: `RESERVED_NAME` is checked before the value, so this is only ever
 * reached for a name a `U` or an admin `A` has moved out (§4.1).
 *
 * Settlement reads the fee owed from here, never from a band table of its
 * own (§10.5, §10.7): the surplus refund and the referral share are both
 * derived from the number the value check used.
 */
export const feeFor = (name: string, prices: Prices, lifetime = false): bigint => {
  const yearly = prices.feeBase * feeMultiplier(name.length)
  return lifetime ? yearly * CONSTANTS.LIFETIME_MULTIPLIER : yearly
}

/**
 * The term a `G`, `N` or `U` award adds (§6, §10.4): `TERM_LENGTH`, or
 * `LIFETIME_TERMS` of them for a lifetime — a plain number of blocks, so the
 * expiry it produces is an ordinary height and nothing downstream has a
 * second case.
 */
export const termFor = (lifetime: boolean): number =>
  lifetime ? CONSTANTS.LIFETIME_TERMS * CONSTANTS.TERM_LENGTH : CONSTANTS.TERM_LENGTH

/**
 * §6 `M`: `floor(price × rate)`, with the seller taking the remainder.
 *
 * `BASIS_POINTS` is the unit denominator that gives `commissionBp` its
 * meaning — a fixed unit, not a governable value.
 */
export const commissionOn = (price: bigint, commissionBp: bigint): bigint =>
  (price * commissionBp) / CONSTANTS.BASIS_POINTS

// ── reduce ──────────────────────────────────────────────────────────────────

/**
 * §7.4: an amount below `REFUND_FLOOR` is forfeited rather than refunded.
 * Without a floor, an attacker could convert thousands of trivially
 * underfunded messages into an obligation to broadcast thousands of
 * transactions.
 */
/**
 * §10.5 (r29 fold, 2026-09-10): a successful `G` or `N` that paid more than
 * the fee in effect owes the **surplus** back from the treasury — the mirror
 * of the underpayment refund, for the mirror reason: a `P` that lowers the
 * price while the message sits in the mempool lands it over through no
 * fault of the client, and the treasury keeps nothing it did not earn.
 * Below `REFUND_FLOOR` the surplus is forfeit, as an underpayment below the
 * floor is, and for the same reason (one `M` per dust surplus is the
 * attack). The verdict stays `OK` and obligations are not committed (§8.1),
 * so no root and no log hash moves.
 */
function surplusRefund(tx: ChainTransaction, fee: bigint): readonly Obligation[] {
  const surplus = tx.value - fee
  if (surplus < CONSTANTS.REFUND_FLOOR) return []
  const ref: TxRef = { height: tx.blockNumber, txIndex: tx.txIndex }
  return [obligation(ref, 'REFUND', CONSTANTS.TREASURY_ADDRESS, tx.sender, surplus)]
}

function refundOrForfeit(tx: ChainTransaction, reason: RefundReason, owedBy: Address): Verdict {
  if (tx.value < CONSTANTS.REFUND_FLOOR) return forfeit('BELOW_REFUND_FLOOR')
  const ref: TxRef = { height: tx.blockNumber, txIndex: tx.txIndex }
  return { kind: 'REFUND', reason, obligations: [obligation(ref, 'REFUND', owedBy, tx.sender, tx.value)] }
}

function withObligations(state: NnsState, obligations: readonly Obligation[]): NnsState {
  if (obligations.length === 0) return state
  const draft = draftOf(state)
  for (const item of obligations) {
    const key = refKey(item.ref)
    draft.outstanding.set(key, [...(draft.outstanding.get(key) ?? []), item])
  }
  return freeze(draft)
}

/**
 * Apply one transaction.
 *
 * The returned state is a new frozen object; the input is never mutated. An
 * `IGNORED` verdict earns no log line (§7.6); everything else does.
 */
export function reduce(state: NnsState, tx: ChainTransaction, config: NnsConfig): ReduceResult {
  // ── §7.5, before a message is even parsed ─────────────────────────────────
  // The network and launch checks come first: a transaction from another
  // chain, or from before LAUNCH_HEIGHT, must not even advance our height.
  if (tx.networkId !== config.networkId) return { state, verdict: ignored('WRONG_NETWORK') }
  if (tx.blockNumber < CONSTANTS.LAUNCH_HEIGHT) return { state, verdict: ignored('BEFORE_LAUNCH') }

  const advanced = advanceTo(state, tx.blockNumber)

  // The rule that matters: Albatross includes failed transactions in blocks,
  // so without this a failed `G` would take a name, and two implementations
  // disagreeing about it would produce different roots.
  if (!tx.executionResult) return { state: advanced, verdict: ignored('FAILED_EXECUTION') }
  if (tx.isReward === true) return { state: advanced, verdict: ignored('REWARD_TRANSACTION') }

  const result = parse(tx.recipientData)
  if (!result.ok) {
    switch (result.reason) {
      // Not ours at all. §7.5 discards it, so it never reaches the log.
      case 'NOT_NNS1':
      case 'NOT_HEX':
        return { state: advanced, verdict: ignored('NOT_NNS1') }
      // Prefixed `NNS1` but unusable. Survives §7.5, so it is logged (§7.6)
      // with a §7.4 forfeit.
      case 'UNKNOWN_TYPE':
        return { state: advanced, verdict: forfeit('UNKNOWN_TYPE') }
      case 'OVER_LENGTH':
        return { state: advanced, verdict: forfeit('OVER_LENGTH') }
      case 'MALFORMED_PAYLOAD':
        return { state: advanced, verdict: forfeit('MALFORMED_PAYLOAD') }
    }
  }

  // §7.2 step 2c: attribute the message to the key that authorized the
  // spend, not the account it left from (attribution.ts has the argument).
  // One substitution here and every owner check, WRONG_SENDER check and
  // refund payee downstream uses the attributed address without knowing the
  // rule exists. Callers that pre-substitute (the pipeline does, so §8.2's
  // log line carries the effective sender) pass through unchanged — the
  // derivation is idempotent.
  const attributed = effectiveSender(tx)
  const attributedTx = addressEquals(attributed, tx.sender) ? tx : { ...tx, sender: attributed }

  const verdictAndState = apply(advanced, attributedTx, result.message)
  const obligations =
    verdictAndState.verdict.kind === 'OK' || verdictAndState.verdict.kind === 'REFUND'
      ? verdictAndState.verdict.obligations
      : []
  return { state: withObligations(verdictAndState.state, obligations), verdict: verdictAndState.verdict }
}

function apply(state: NnsState, tx: ChainTransaction, message: Message): ReduceResult {
  const ref: TxRef = { height: tx.blockNumber, txIndex: tx.txIndex }
  const keep = (verdict: Verdict): ReduceResult => ({ state, verdict })

  switch (message.type) {
    // ── G — Register (§6) ────────────────────────────────────────────────────
    case 'G': {
      if (!addressEquals(tx.recipient, CONSTANTS.TREASURY_ADDRESS)) return keep(forfeit('WRONG_RECIPIENT'))

      // §4.1 in full, against chain state: both membership routes live inside
      // validateName — the frozen published list and the by-rule short names —
      // and state.unreserved is the part already released. RESERVED is the one
      // reason with its own token: a held short name forfeits RESERVED_NAME,
      // not INVALID_NAME (§7.4), and a released one registers normally.
      const check = validateName(message.name, state.unreserved)
      if (!check.ok) {
        return keep(forfeit(check.reason === 'RESERVED' ? 'RESERVED_NAME' : 'INVALID_NAME'))
      }

      // Value is checked before availability. Since r29 both are refunds owed
      // by the treasury, so the order decides only which token the log carries
      // — §7.4 fixes it, and `INSUFFICIENT_VALUE` is the more informative of
      // two true answers about a message that underpaid for a taken name.
      const fee = feeFor(message.name, state.prices, message.lifetime)
      if (tx.value < fee) {
        return keep(refundOrForfeit(tx, 'INSUFFICIENT_VALUE', CONSTANTS.TREASURY_ADDRESS))
      }

      const existing = state.names.get(message.name)
      if (existing !== undefined) {
        // §7.4: a `G` for a name in GRACE is forfeit — the status and its end
        // height are provable from the checkpoint tree, so a correct client
        // prevents it. Losing a race to a transaction ordered ahead is not
        // client-preventable, so it is refunded.
        if (existing.status === 'GRACE') return keep(forfeit('NAME_IN_GRACE'))
        return keep(refundOrForfeit(tx, 'LOST_REGISTRATION_RACE', CONSTANTS.TREASURY_ADDRESS))
      }

      const draft = draftOf(state)
      const expiry = tx.blockNumber + termFor(message.lifetime)
      draft.names.set(message.name, {
        name: message.name,
        owner: tx.sender,
        target: tx.sender,
        expiry,
        status: 'REGISTERED',
        host: '',
        evm: '',
      })
      schedule(draft, expiry)
      return { state: freeze(draft), verdict: ok(surplusRefund(tx, fee)) }
    }

    // ── S — Set resolution target (§6) ───────────────────────────────────────
    case 'S': {
      const record = state.names.get(message.name)
      if (record === undefined || record.status !== 'REGISTERED') return keep(forfeit('NAME_NOT_REGISTERED'))
      if (!addressEquals(record.owner, tx.sender)) return keep(forfeit('NOT_OWNER'))

      // §5.3 sentinel: the owner cannot name themselves as recipient, so
      // PROTOCOL_ADDRESS means "reset the target to my own address".
      const target = addressEquals(tx.recipient, CONSTANTS.PROTOCOL_ADDRESS) ? tx.sender : tx.recipient

      const draft = draftOf(state)
      draft.names.set(message.name, { ...record, target })
      return { state: freeze(draft), verdict: ok() }
    }

    // ── E — Set EVM address (§6) ─────────────────────────────────────────────
    case 'E': {
      if (!addressEquals(tx.recipient, CONSTANTS.PROTOCOL_ADDRESS)) return keep(forfeit('WRONG_RECIPIENT'))
      const record = state.names.get(message.name)
      if (record === undefined || record.status !== 'REGISTERED') return keep(forfeit('NAME_NOT_REGISTERED'))
      if (!addressEquals(record.owner, tx.sender)) return keep(forfeit('NOT_OWNER'))

      // The payload was judged at parse: a non-canonical evm field is
      // MALFORMED_PAYLOAD before this case is reached (§6 `E`), so `evm` here
      // is `''` (clear) or a valid lowercase 0x-hex address.
      const draft = draftOf(state)
      draft.names.set(message.name, { ...record, evm: message.evm })
      return { state: freeze(draft), verdict: ok() }
    }

    // ── X — Transfer ownership (§6) ──────────────────────────────────────────
    case 'X': {
      const record = state.names.get(message.name)
      if (record === undefined || record.status !== 'REGISTERED') return keep(forfeit('NAME_NOT_REGISTERED'))

      if (!addressEquals(record.owner, tx.sender)) return keep(forfeit('NOT_OWNER'))
      const busy = pendingOn(state, message.name)
      if (busy !== null && busy !== 'TRANSFER_PENDING') return keep(forfeit(busy))

      const effectiveHeight = tx.blockNumber + CONSTANTS.XFER_TIMELOCK

      // A second X replaces the first and restarts the timelock (§7.3): the
      // owner restating where the name goes, and the one way to fix a
      // mistyped recipient without a round trip through `K`.
      const draft = draftOf(state)
      draft.transfers.set(message.name, {
        name: message.name,
        newOwner: tx.recipient,
        effectiveHeight,
      })
      // Recomputed, not `schedule`d: the replaced transfer's maturity may be
      // exactly what the bound pointed at, and it is earlier than the new one.
      draft.nextDueHeight = computeNextDue(draft)
      return { state: freeze(draft), verdict: ok() }
    }

    // ── D — Set delegate resolver (§6) ───────────────────────────────────────
    case 'D': {
      if (!addressEquals(tx.recipient, CONSTANTS.PROTOCOL_ADDRESS)) return keep(forfeit('WRONG_RECIPIENT'))
      const record = state.names.get(message.name)
      if (record === undefined || record.status !== 'REGISTERED') return keep(forfeit('NAME_NOT_REGISTERED'))
      if (!addressEquals(record.owner, tx.sender)) return keep(forfeit('NOT_OWNER'))
      if (!validateHost(message.host).ok) return keep(forfeit('INVALID_HOST'))

      const draft = draftOf(state)
      draft.names.set(message.name, { ...record, host: message.host })
      return { state: freeze(draft), verdict: ok() }
    }

    // ── K — Cancel (§6) ──────────────────────────────────────────────────────
    case 'K': {
      if (!addressEquals(tx.recipient, CONSTANTS.PROTOCOL_ADDRESS)) return keep(forfeit('WRONG_RECIPIENT'))
      const record = state.names.get(message.name)
      if (record === undefined) return keep(forfeit('NAME_NOT_FOUND'))

      if (!addressEquals(record.owner, tx.sender)) return keep(forfeit('NOT_OWNER'))

      // §6 `K`: a pending `X` or an open `O`, at any height — an auction is
      // the one pending thing a `K` cannot touch, because a bid is money
      // committed against the window. No cancel delay on either side since
      // the r30 fold: a `B` pays the marketplace and moves the name only if
      // the sale is still open when it lands, so a cancel racing a buyer
      // costs the buyer a refund wait and never money, and a delay bought
      // nothing — the argument §6 `K` already made for r6's `CANCEL_DELAY`.
      const draft = draftOf(state)
      let cancelled = false
      if (draft.transfers.delete(message.name)) cancelled = true
      if (draft.offers.delete(message.name)) cancelled = true
      if (!cancelled) return keep(forfeit('NOTHING_TO_CANCEL'))
      draft.nextDueHeight = computeNextDue(draft)
      return { state: freeze(draft), verdict: ok() }
    }

    // ── N — Renew (§6) ───────────────────────────────────────────────────────
    case 'N': {
      if (!addressEquals(tx.recipient, CONSTANTS.TREASURY_ADDRESS)) return keep(forfeit('WRONG_RECIPIENT'))
      // Sender: anyone. A grace name can still be renewed by its former owner.
      const record = state.names.get(message.name)
      if (record === undefined) return keep(forfeit('NAME_NOT_FOUND'))
      const fee = feeFor(message.name, state.prices, message.lifetime)
      if (tx.value < fee) {
        return keep(refundOrForfeit(tx, 'INSUFFICIENT_VALUE', CONSTANTS.TREASURY_ADDRESS))
      }

      // Extends from the current expiry, not the renewal height, so early
      // renewal is never penalised. An `N|L` on a yearly name is the upgrade
      // to a lifetime; an `N` on a lifetime name adds a year to a date a
      // century out, which needs no rule (§6 `N`).
      const expiry = record.expiry + termFor(message.lifetime)
      const status = expiry > tx.blockNumber ? 'REGISTERED' : record.status

      const draft = draftOf(state)
      draft.names.set(message.name, { ...record, expiry, status })
      draft.nextDueHeight = computeNextDue(draft)
      schedule(draft, expiry)
      return { state: freeze(draft), verdict: ok(surplusRefund(tx, fee)) }
    }

    // ── O — Offer (§6) ───────────────────────────────────────────────────────
    case 'O': {
      if (!addressEquals(tx.recipient, CONSTANTS.TREASURY_ADDRESS)) return keep(forfeit('WRONG_RECIPIENT'))
      const record = state.names.get(message.name)
      if (record === undefined || record.status !== 'REGISTERED') return keep(forfeit('NAME_NOT_REGISTERED'))
      if (!addressEquals(record.owner, tx.sender)) return keep(forfeit('NOT_OWNER'))
      const busy = pendingOn(state, message.name)
      if (busy !== null && busy !== 'OFFER_OPEN') return keep(forfeit(busy))

      // §6 `O`: the price MUST be ≥ MIN_PRICE, which is FEE_BASE **at this
      // message's height** — a governed value, so it is read from the active
      // params and never from `constants.ts`. Below the floor the message
      // forfeits: like an invalid name, it is preventable by the client from
      // state it can already prove. Checked before the value carried, for the
      // same reason `G` checks name syntax before value: a message whose own
      // payload is unusable is rejected on that ground whatever it paid.
      if (message.price < minPrice(state.prices)) return keep(forfeit('BELOW_MIN_PRICE'))
      // Frozen at zero (§12 item 3), so this never fires today — kept because
      // the rule is the rule, and the day a spec revision moves the fee the
      // check must already be in the right place relative to the floor above.
      if (tx.value < CONSTANTS.LISTING_FEE) {
        return keep(refundOrForfeit(tx, 'INSUFFICIENT_VALUE', CONSTANTS.TREASURY_ADDRESS))
      }

      const expiryHeight = tx.blockNumber + CONSTANTS.OFFER_MAX_LIFETIME
      // A later O replaces the standing one (§7.3): a reprice, with a fresh
      // lifetime. A `B` at the old price in flight is refunded WRONG_PRICE.
      const draft = draftOf(state)
      draft.offers.set(message.name, {
        name: message.name,
        seller: tx.sender,
        price: message.price,
        openedHeight: tx.blockNumber,
        expiryHeight,
      })
      // Covers the offer's own expiry: it is in the draft already.
      draft.nextDueHeight = computeNextDue(draft)
      return { state: freeze(draft), verdict: ok() }
    }

    // ── B — Buy (§6) ─────────────────────────────────────────────────────────
    case 'B': {
      if (!addressEquals(tx.recipient, CONSTANTS.MARKETPLACE_ADDRESS)) return keep(forfeit('WRONG_RECIPIENT'))

      // §6 `A`: a `B` whose name has an open auction is a bid, and state is
      // what decides that — an auction and an offer never coexist, so the
      // same payload can only mean one thing at any height. The auction is in
      // the map, therefore it is open: a close fires in `advanceTo` before
      // this block's transactions, so nothing here has to compare heights.
      const auction = state.auctions.get(message.name)
      if (auction !== undefined) {
        if (tx.value < requiredBid(auction)) {
          return keep(refundOrForfeit(tx, 'WRONG_PRICE', CONSTANTS.MARKETPLACE_ADDRESS))
        }
        const draft = draftOf(state)
        // The outbid bidder is refunded now, keyed by their own bid, so the
        // marketplace holds one bid per auction rather than every bid for
        // the life of the window.
        const refunds: Obligation[] = []
        if (auction.bidder !== null && auction.bidRef !== null) {
          refunds.push(obligation(auction.bidRef, 'REFUND', CONSTANTS.MARKETPLACE_ADDRESS, auction.bidder, auction.bid))
        }
        // Anti-sniping: the end is never less than AUCTION_EXTENSION after
        // the last successful bid.
        const endHeight = Math.max(auction.endHeight, tx.blockNumber + CONSTANTS.AUCTION_EXTENSION)
        draft.auctions.set(message.name, {
          ...auction,
          endHeight,
          bidder: tx.sender,
          bid: tx.value,
          bidRef: ref,
        })
        draft.nextDueHeight = computeNextDue(draft)
        return { state: freeze(draft), verdict: ok(refunds) }
      }

      const offer = state.offers.get(message.name)
      const record = state.names.get(message.name)
      // Covers the race loser and a cancelled or expired offer — and, since
      // r28, a `B` on a name whose auction has already closed. All are
      // refunded identically, so the log does not need to tell them apart.
      if (offer === undefined || record === undefined || record.status !== 'REGISTERED') {
        return keep(refundOrForfeit(tx, 'OFFER_NOT_OPEN', CONSTANTS.MARKETPLACE_ADDRESS))
      }
      if (tx.value !== offer.price) return keep(refundOrForfeit(tx, 'WRONG_PRICE', CONSTANTS.MARKETPLACE_ADDRESS))

      // Ownership moves immediately and deterministically. Settlement never
      // gates the transfer: the marketplace operator handles money, never
      // names, so a stalled or dishonest operator cannot touch resolution.
      const commission = commissionOn(offer.price, state.prices.commissionBp)
      const proceeds = offer.price - commission

      const draft = draftOf(state)
      applyTransfer(draft, message.name, tx.sender)
      draft.nextDueHeight = computeNextDue(draft)

      const obligations = [
        obligation(ref, 'SALE_PROCEEDS', CONSTANTS.MARKETPLACE_ADDRESS, offer.seller, proceeds),
        obligation(ref, 'COMMISSION', CONSTANTS.MARKETPLACE_ADDRESS, CONSTANTS.TREASURY_ADDRESS, commission),
      ]
      return { state: freeze(draft), verdict: ok(obligations) }
    }

    // ── M — Settlement (§6) ──────────────────────────────────────────────────
    case 'M': {
      // Whichever address holds the funds: the marketplace for a B, the
      // treasury for a refunded G.
      const fromMarketplace = addressEquals(tx.sender, CONSTANTS.MARKETPLACE_ADDRESS)
      const fromTreasury = addressEquals(tx.sender, CONSTANTS.TREASURY_ADDRESS)
      if (!fromMarketplace && !fromTreasury) return keep(forfeit('WRONG_SENDER'))

      const key = refKey({ height: message.height, txIndex: message.txIndex })
      const owed = state.outstanding.get(key)
      if (owed === undefined) return keep(ok())

      // Discharge only the leg this payment actually matches. A winning B
      // settles as two M transactions — seller and treasury — and an M that
      // matches nothing leaves the debt standing, which is precisely how the
      // log makes a shortfall permanently visible.
      const index = owed.findIndex(
        (item) =>
          addressEquals(item.owedTo, tx.recipient) &&
          addressEquals(item.owedBy, tx.sender) &&
          item.amount === tx.value,
      )
      if (index < 0) return keep(ok())

      const draft = draftOf(state)
      const remaining = owed.filter((_, i) => i !== index)
      if (remaining.length === 0) draft.outstanding.delete(key)
      else draft.outstanding.set(key, remaining)
      return { state: freeze(draft), verdict: ok() }
    }

    // ── A — Auction (§6) ─────────────────────────────────────────────────────
    case 'A': {
      if (!addressEquals(tx.recipient, CONSTANTS.PROTOCOL_ADDRESS)) return keep(forfeit('WRONG_RECIPIENT'))

      // Which auction this is, decided by the name's state before anything
      // about the sender: a name with a record is the owner's to auction, a
      // name still held in RESERVED_NAMES is the admin's. The name rows lead
      // the sender rows for the reason §7.4 gives for `O` — a sender check
      // against a name nobody could auction would be the less informative of
      // two true answers.
      const record = state.names.get(message.name)
      let seller: Address
      if (record !== undefined) {
        if (record.status !== 'REGISTERED') return keep(forfeit('NAME_NOT_REGISTERED'))
        if (!addressEquals(record.owner, tx.sender)) return keep(forfeit('NOT_OWNER'))
        seller = tx.sender
      } else {
        if (!isReserved(state, message.name)) return keep(forfeit('NAME_NOT_FOUND'))
        if (!addressEquals(tx.sender, CONSTANTS.ADMIN_ADDRESS)) return keep(forfeit('NOT_ADMIN'))
        seller = CONSTANTS.TREASURY_ADDRESS
      }
      const busy = pendingOn(state, message.name)
      if (busy !== null) return keep(forfeit(busy))
      // Payload after state and authority, as for `O`: the floor first —
      // it is what keeps the increment rule from rounding to zero — then the
      // window, measured from the landing block like `P`'s notice.
      if (message.startingPrice < minPrice(state.prices)) return keep(forfeit('BELOW_MIN_PRICE'))
      if (message.endHeight < tx.blockNumber + CONSTANTS.AUCTION_MIN_DURATION) {
        return keep(forfeit('INSUFFICIENT_NOTICE'))
      }
      // An auction sells the current term: the owner's window must end
      // before the name's expiry (2026-09-03). Expiry is in the checkpoint, so
      // a correct client prevents this. An admin auction of a still-reserved
      // name has no term to fit. An extension can still push an end to or
      // past expiry — the §7.3 grace reset then cancels it with a refund,
      // firing ahead of the close when the two are due at one height.
      if (record !== undefined && message.endHeight >= record.expiry) return keep(forfeit('AUCTION_BEYOND_TERM'))

      const draft = draftOf(state)
      draft.auctions.set(message.name, {
        name: message.name,
        seller,
        startingPrice: message.startingPrice,
        endHeight: message.endHeight,
        bidder: null,
        bid: 0n,
        bidRef: null,
      })
      draft.nextDueHeight = computeNextDue(draft)
      return { state: freeze(draft), verdict: ok() }
    }

    // ── P — Governance (§6, §10.6) ───────────────────────────────────────────
    case 'P': {
      if (!addressEquals(tx.recipient, CONSTANTS.PROTOCOL_ADDRESS)) return keep(forfeit('WRONG_RECIPIENT'))
      if (!addressEquals(tx.sender, CONSTANTS.ADMIN_ADDRESS)) return keep(forfeit('NOT_ADMIN'))
      if (message.effectiveHeight < tx.blockNumber + CONSTANTS.GOVERNANCE_DELAY) {
        return keep(forfeit('INSUFFICIENT_NOTICE'))
      }
      if (governanceBoundViolation(state.prices, message) !== null) return keep(forfeit('GOVERNANCE_BOUND_VIOLATED'))

      const draft = draftOf(state)
      draft.pendingGovernance = {
        prices: { feeBase: message.feeBase, commissionBp: message.commissionBp },
        effectiveHeight: message.effectiveHeight,
      }
      // Informational since the frequency bound was removed (§10.6): no rule
      // reads it, and it is committed nowhere. Kept because "when did
      // governance last act" is worth answering without replaying the log.
      draft.lastGovernanceHeight = tx.blockNumber
      schedule(draft, message.effectiveHeight)
      return { state: freeze(draft), verdict: ok() }
    }

    // ── U — Unreserve (§6) ───────────────────────────────────────────────────
    case 'U': {
      // Since r17 `U` has no recipient *routing* check: the recipient is an
      // operand — PROTOCOL_ADDRESS releases the name, any other address is
      // awarded it — so it gets a row of its own rather than the §5.3 check
      // that precedes everything else (§7.4).
      if (!addressEquals(tx.sender, CONSTANTS.ADMIN_ADDRESS)) return keep(forfeit('NOT_ADMIN'))
      // The one forbidden recipient. BURN_ADDRESS has no key, and it is the
      // all-zero address §8.1 uses to encode *no* recipient (§6 U).
      if (addressEquals(tx.recipient, BURN_ADDRESS)) return keep(forfeit('INVALID_RECIPIENT'))
      // r22: no notice row. `GOVERNANCE_DELAY` is `P`'s alone — a `U` executes
      // here, in this block. See §6 `U`: an award has no party to warn, and a
      // scheduled release warns only a frontrunner.
      //
      // §4.1 rules 2–5 and the ceiling. The floor never binds a `U`:
      // well-formed short names are reserved by rule (§4.1) and are exactly
      // what `U` exists to release or award, so RESERVED from the full check
      // is an expected answer, not a failure. TOO_SHORT — a short name
      // failing rules 2–5, on neither membership route — still forfeits here.
      const check = validateName(message.name, state.unreserved)
      if (!check.ok && check.reason !== 'RESERVED') return keep(forfeit('INVALID_NAME'))
      // The last row is the operation's own (§7.4), and the recipient chose
      // the operation. A release inverts rule 6: the name must be *in*
      // RESERVED_NAMES and not yet released — also what a second `U` for the
      // same name earns since r22, the first having fired on landing. An
      // award reaches any name nobody owns (2026-09-11): reserved and
      // unreleased, or plain AVAILABLE — never REGISTERED or in GRACE, since
      // §10.6 lets no `U` touch a held name.
      const release = addressEquals(tx.recipient, CONSTANTS.PROTOCOL_ADDRESS)
      if (release) {
        if (!isReserved(state, message.name)) return keep(forfeit('NAME_NOT_RESERVED'))
      } else if (state.names.has(message.name)) {
        return keep(forfeit('NAME_NOT_AVAILABLE'))
      }

      const draft = draftOf(state)
      // A name that was reserved joins the unreserved set either way; one
      // that never was leaves the set untouched (§6 `U`, §8.1 tag 0x0A).
      if (isReservedName(message.name)) draft.unreserved.add(message.name)
      // §6 `U`: an award additionally creates the REGISTERED record — owner
      // and target the awardee, a full term from this block (or a lifetime
      // with `L`), delegate host and EVM address unset, nothing pending.
      // Nothing is owed and no fee is earned. A release stops at the line
      // above — it has no term and ignores `L` — and the name is AVAILABLE
      // under the normal rules.
      if (!release) {
        const expiry = tx.blockNumber + termFor(message.lifetime)
        draft.names.set(message.name, {
          name: message.name,
          owner: tx.recipient,
          target: tx.recipient,
          expiry,
          status: 'REGISTERED',
          host: '',
          evm: '',
        })
        schedule(draft, expiry)
      }
      return { state: freeze(draft), verdict: ok() }
    }

    // ── F — Burn attestation (§6) ────────────────────────────────────────────
    case 'F': {
      if (!addressEquals(tx.recipient, BURN_ADDRESS)) return keep(forfeit('WRONG_RECIPIENT'))
      if (!addressEquals(tx.sender, CONSTANTS.TREASURY_ADDRESS)) return keep(forfeit('WRONG_SENDER'))
      // No protocol effect. It exists to make the burn commitment auditable.
      return keep(ok())
    }
  }
}

/**
 * Which §10.6 row a proposed `P` breaks. Diagnostic, never a log token.
 * `ORDERING` — `fee_long ≤ fee_standard` — left with the second price on
 * 2026-09-11; one base fee has nothing to be out of order with.
 */
export type GovernanceBound = 'PRICE_BAND' | 'COMMISSION_CEILING' | 'COMMISSION_MAX_STEP'

export interface GovernanceBoundViolation {
  readonly bound: GovernanceBound
  /** The row, the numbers, and the limit — for a client to print before sending. */
  readonly message: string
}

/**
 * §10.6 bounds, enforced independently by every indexer. `null` means every
 * bound holds.
 *
 * **These are fat-finger rails, not attack protection** (§10.6). The rate
 * limits that used to sit here — `PRICE_MAX_FACTOR` and `PRICE_MIN_INTERVAL` —
 * are gone: a limit loose enough not to obstruct legitimate repricing during
 * NIM volatility is also loose enough for an attacker to walk through, so what
 * bounds a hostile `P` is `GOVERNANCE_DELAY`'s notice and, past that, a fork.
 *
 * Compared against the **active** prices rather than a pending `P`'s. Two `P`s
 * may now land inside one `GOVERNANCE_DELAY`, so the second is checked against
 * prices the first is about to replace — deliberately: the active prices are
 * the ones every indexer agrees on at that height, and a pending change is not
 * yet a fact about the registry.
 *
 * It reports *which* bound broke rather than a boolean because the reducer is
 * not the only caller: a `P` that violates one is forfeited on-chain and
 * cannot be retracted, so the builder of the message has to be able to say
 * what is wrong with it before it is signed. The verdict token stays the
 * single `GOVERNANCE_BOUND_VIOLATED` — this subdivision never reaches the log,
 * so it cannot make two implementations disagree.
 */
export function governanceBoundViolation(
  current: Prices,
  proposed: { feeBase: bigint; commissionBp: bigint },
): GovernanceBoundViolation | null {
  const violation = (bound: GovernanceBound, message: string): GovernanceBoundViolation => ({ bound, message })

  if (proposed.feeBase < CONSTANTS.PRICE_FLOOR || proposed.feeBase > CONSTANTS.PRICE_CEILING) {
    return violation(
      'PRICE_BAND',
      `fee_base ${proposed.feeBase} is outside PRICE_FLOOR … PRICE_CEILING (${CONSTANTS.PRICE_FLOOR} … ${CONSTANTS.PRICE_CEILING} luna)`,
    )
  }

  if (proposed.commissionBp > CONSTANTS.COMMISSION_CEILING) {
    return violation(
      'COMMISSION_CEILING',
      `commission_bp ${proposed.commissionBp} is above COMMISSION_CEILING (${CONSTANTS.COMMISSION_CEILING} bp)`,
    )
  }
  const step =
    proposed.commissionBp > current.commissionBp
      ? proposed.commissionBp - current.commissionBp
      : current.commissionBp - proposed.commissionBp
  if (step > CONSTANTS.COMMISSION_MAX_STEP) {
    return violation(
      'COMMISSION_MAX_STEP',
      `commission_bp ${current.commissionBp} → ${proposed.commissionBp} moves ${step} bp, ` +
        `above COMMISSION_MAX_STEP (${CONSTANTS.COMMISSION_MAX_STEP} bp)`,
    )
  }
  return null
}
