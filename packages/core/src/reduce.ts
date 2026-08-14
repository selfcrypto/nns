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
 * ## What is not here
 *
 * `A` (auction) has no bidding state machine in v1. §6 calls the type
 * "deliberately additive" and §13 puts it last in the build order. An `A` is
 * parsed and logged and takes a `AUCTION_NOT_IN_V1` forfeit — and **any
 * implementation claiming v1 conformance must do the same**, because an
 * implementation that honoured auctions would derive a different root from one
 * that did not. Enabling `A` is a spec-version change, not a feature flag.
 */

import { type Address, addressEquals } from './address.js'
import { BURN_ADDRESS, type Message, parse } from './codec.js'
import type { NnsConfig } from './config.js'
import { CONSTANTS } from './constants.js'
import { feeBand, validateHost, validateName } from './name.js'
import {
  type NameRecord,
  type NnsState,
  type Obligation,
  type Offer,
  type PendingGovernance,
  type PendingRecovery,
  type PendingTransfer,
  type PendingUnreserve,
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
 * `txIndex` is the **zero-based** position in the block body array. The RPC
 * object carries no index, position or ordering field — verified 2026-08-06
 * against the full object — so canonical order is `(blockNumber, array
 * position)` and every implementation must derive it the same way (§5.2).
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
  | 'INSUFFICIENT_VALUE'
  | 'INVALID_NAME'
  | 'RESERVED_NAME'
  | 'NAME_IN_GRACE'
  | 'NAME_NOT_REGISTERED'
  | 'NAME_NOT_FOUND'
  | 'NOT_OWNER'
  | 'NOT_OWNER_OR_RECOVERY'
  | 'INVALID_HOST'
  | 'NOT_ADMIN'
  | 'GOVERNANCE_BOUND_VIOLATED'
  | 'INSUFFICIENT_NOTICE'
  | 'NAME_NOT_RESERVED'
  | 'UNRESERVE_PENDING'
  | 'TOO_SOON'
  | 'NOTHING_TO_CANCEL'
  | 'BELOW_REFUND_FLOOR'
  | 'BELOW_MIN_PRICE'
  | 'AUCTION_NOT_IN_V1'

/** §7.4 refundable column — losses caused by concurrency, not by the client. */
export type RefundReason = 'LOST_REGISTRATION_RACE' | 'OFFER_NOT_OPEN' | 'WRONG_PRICE'

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
  recoveries: Map<string, PendingRecovery>
  offers: Map<string, Offer>
  prices: Prices
  pendingGovernance: PendingGovernance | null
  lastGovernanceHeight: number | null
  unreserved: Set<string>
  pendingUnreserve: Map<string, PendingUnreserve>
  outstanding: Map<string, readonly Obligation[]>
  nextDueHeight: number
}

const draftOf = (state: NnsState): Draft => ({
  height: state.height,
  names: new Map(state.names),
  transfers: new Map(state.transfers),
  recoveries: new Map(state.recoveries),
  offers: new Map(state.offers),
  prices: state.prices,
  pendingGovernance: state.pendingGovernance,
  lastGovernanceHeight: state.lastGovernanceHeight,
  unreserved: new Set(state.unreserved),
  pendingUnreserve: new Map(state.pendingUnreserve),
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
  for (const item of draft.pendingUnreserve.values()) consider(item.effectiveHeight)
  for (const item of draft.transfers.values()) consider(item.effectiveHeight)
  for (const item of draft.recoveries.values()) consider(item.effectiveHeight)
  for (const item of draft.offers.values()) consider(item.expiryHeight)
  for (const record of draft.names.values()) {
    if (record.status === 'REGISTERED') consider(record.expiry)
    else consider(record.expiry + CONSTANTS.GRACE_PERIOD)
  }
  return next
}

// ── §7.3 dependent-state resets ─────────────────────────────────────────────

/**
 * §7.3: on a transfer taking effect (`X` after its timelock, or `B`), owner
 * and target both become the new owner, the delegate host and recovery address
 * are cleared, open offers are cancelled, and any pending `X` or `R` is void.
 *
 * A clean slate is the safe default — in particular the old target must not
 * keep receiving funds sent to the name — and the new owner reconfigures
 * explicitly.
 */
function applyTransfer(draft: Draft, name: string, newOwner: Address): void {
  const record = draft.names.get(name)
  if (record === undefined) return
  draft.names.set(name, { ...record, owner: newOwner, target: newOwner, recovery: null, host: '' })
  draft.transfers.delete(name)
  draft.recoveries.delete(name)
  draft.offers.delete(name)
}

/**
 * §7.3 on entering `GRACE`: the delegate host is cleared — a lapsed name
 * cannot keep answering for its subdomains — and open offers and pending
 * `X`/`R` are cancelled.
 */
function enterGrace(draft: Draft, name: string): void {
  const record = draft.names.get(name)
  if (record === undefined) return
  draft.names.set(name, { ...record, status: 'GRACE', host: '' })
  draft.transfers.delete(name)
  draft.recoveries.delete(name)
  draft.offers.delete(name)
  schedule(draft, record.expiry + CONSTANTS.GRACE_PERIOD)
}

/** §7.3 on falling to `AVAILABLE`: all state for the name is cleared. */
function release(draft: Draft, name: string): void {
  draft.names.delete(name)
  draft.transfers.delete(name)
  draft.recoveries.delete(name)
  draft.offers.delete(name)
}

// ── Height-driven effects ───────────────────────────────────────────────────

/**
 * Categories of scheduled effect, in the order they fire when several come due
 * at the same height. **This list is §7.3's, in §7.3's order** — governance
 * activation, unreserve activation, maturing `X`, maturing `R`, expiry to
 * `GRACE`, grace release to `AVAILABLE`, offer expiry — with ties inside a
 * category broken bytewise by name.
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
 * (`TRANSFER` against `RECOVERY` looks like it should diverge and does not:
 * whichever runs first, the recovery address ends up `null`, because a
 * transfer both clears it and deletes the pending `R`.)
 *
 * Proposed here first, then ratified into §7.3 by spec r15.
 */
const ORDER = {
  GOVERNANCE: 0,
  UNRESERVE: 1,
  TRANSFER: 2,
  RECOVERY: 3,
  EXPIRE: 4,
  RELEASE: 5,
  OFFER_EXPIRE: 6,
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

  for (const item of draft.pendingUnreserve.values()) {
    if (item.effectiveHeight > upto) continue
    due.push({
      height: item.effectiveHeight,
      order: ORDER.UNRESERVE,
      key: item.name,
      apply: (d) => {
        const pending = d.pendingUnreserve.get(item.name)
        if (pending === undefined || pending.effectiveHeight > upto) return
        d.pendingUnreserve.delete(item.name)
        d.unreserved.add(item.name)
        // §7.3: an award additionally creates the REGISTERED record — owner
        // and target the awardee, full TERM_LENGTH from the effective height,
        // recovery and delegate host unset, nothing pending. A release stops
        // at the line above and the name is AVAILABLE under the normal rules.
        if (pending.recipient !== null) {
          const expiry = pending.effectiveHeight + CONSTANTS.TERM_LENGTH
          d.names.set(item.name, {
            name: item.name,
            owner: pending.recipient,
            target: pending.recipient,
            expiry,
            status: 'REGISTERED',
            recovery: null,
            host: '',
          })
        }
      },
    })
  }

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

  for (const item of draft.recoveries.values()) {
    if (item.effectiveHeight > upto) continue
    due.push({
      height: item.effectiveHeight,
      order: ORDER.RECOVERY,
      key: item.name,
      apply: (d) => {
        const pending = d.recoveries.get(item.name)
        if (pending === undefined || pending.effectiveHeight > upto) return
        d.recoveries.delete(item.name)
        const record = d.names.get(item.name)
        if (record === undefined) return
        d.names.set(item.name, { ...record, recovery: pending.recovery })
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
 * The fee for a name at the prices currently in effect (§10.1).
 *
 * Registrations are validated against the prices in effect at their own block
 * height (§10.6), which is exactly what `state.prices` holds once
 * {@link advanceTo} has run for that height.
 */
export const feeFor = (name: string, prices: Prices): bigint =>
  feeBand(name) === 'LONG' ? prices.feeLong : prices.feeStandard

/**
 * §6 `M`: `floor(price × rate)`, with the seller taking the remainder.
 *
 * `BASIS_POINTS` is the unit denominator that gives `commissionBp` its
 * meaning — a fixed unit, not a governable value.
 */
export const commissionOn = (price: bigint, commissionBp: bigint): bigint =>
  (price * commissionBp) / CONSTANTS.BASIS_POINTS

// ── reduce ──────────────────────────────────────────────────────────────────

const obligation = (
  ref: TxRef,
  kind: Obligation['kind'],
  owedBy: Address,
  owedTo: Address,
  amount: bigint,
): Obligation => Object.freeze({ ref, kind, owedBy, owedTo, amount })

/**
 * §7.4: an amount below `REFUND_FLOOR` is forfeited rather than refunded.
 * Without a floor, an attacker could convert thousands of trivially
 * underfunded messages into an obligation to broadcast thousands of
 * transactions.
 */
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

  const verdictAndState = apply(advanced, tx, result.message)
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

      // Value is checked before availability: underpaying is the client's own
      // fault and belongs in the forfeit column, while losing a race does not.
      // §7.4 does not fix this order — see docs/decisions.md.
      if (tx.value < feeFor(message.name, state.prices)) return keep(forfeit('INSUFFICIENT_VALUE'))

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
      const expiry = tx.blockNumber + CONSTANTS.TERM_LENGTH
      draft.names.set(message.name, {
        name: message.name,
        owner: tx.sender,
        target: tx.sender,
        expiry,
        status: 'REGISTERED',
        recovery: null,
        host: '',
      })
      schedule(draft, expiry)
      return { state: freeze(draft), verdict: ok() }
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

    // ── X — Transfer ownership (§6) ──────────────────────────────────────────
    case 'X': {
      const record = state.names.get(message.name)
      if (record === undefined || record.status !== 'REGISTERED') return keep(forfeit('NAME_NOT_REGISTERED'))

      const byOwner = addressEquals(record.owner, tx.sender)
      const byRecovery = record.recovery !== null && addressEquals(record.recovery, tx.sender)
      if (!byOwner && !byRecovery) return keep(forfeit('NOT_OWNER_OR_RECOVERY'))

      const timelock = byOwner ? CONSTANTS.XFER_TIMELOCK : CONSTANTS.RECOVERY_TIMELOCK
      const effectiveHeight = tx.blockNumber + timelock

      // A second X supersedes the first and restarts the timelock.
      const draft = draftOf(state)
      draft.transfers.set(message.name, {
        name: message.name,
        newOwner: tx.recipient,
        effectiveHeight,
        viaRecovery: !byOwner,
      })
      schedule(draft, effectiveHeight)
      return { state: freeze(draft), verdict: ok() }
    }

    // ── R — Set recovery address (§6) ────────────────────────────────────────
    case 'R': {
      const record = state.names.get(message.name)
      if (record === undefined || record.status !== 'REGISTERED') return keep(forfeit('NAME_NOT_REGISTERED'))
      if (!addressEquals(record.owner, tx.sender)) return keep(forfeit('NOT_OWNER'))

      // Sending to PROTOCOL_ADDRESS clears the recovery address. The r6
      // wording named the owner's own address, which the network cannot carry.
      const recovery = addressEquals(tx.recipient, CONSTANTS.PROTOCOL_ADDRESS) ? null : tx.recipient
      const effectiveHeight = tx.blockNumber + CONSTANTS.XFER_TIMELOCK

      const draft = draftOf(state)
      draft.recoveries.set(message.name, { name: message.name, recovery, effectiveHeight })
      schedule(draft, effectiveHeight)
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

      const byOwner = addressEquals(record.owner, tx.sender)
      const byRecovery = record.recovery !== null && addressEquals(record.recovery, tx.sender)
      if (!byOwner && !byRecovery) return keep(forfeit('NOT_OWNER_OR_RECOVERY'))

      // §6 K vetoes "a pending X or R, or an O past OFFER_IRREVOCABLE — all
      // effective on inclusion". Read as: cancel everything currently
      // cancellable. See docs/decisions.md.
      const draft = draftOf(state)
      let cancelled = false
      if (draft.transfers.delete(message.name)) cancelled = true
      if (draft.recoveries.delete(message.name)) cancelled = true
      const offer = draft.offers.get(message.name)
      if (offer !== undefined && tx.blockNumber >= offer.openedHeight + CONSTANTS.OFFER_IRREVOCABLE) {
        draft.offers.delete(message.name)
        cancelled = true
      }
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
      if (tx.value < feeFor(message.name, state.prices)) return keep(forfeit('INSUFFICIENT_VALUE'))

      // Extends from the current expiry, not the renewal height, so early
      // renewal is never penalised.
      const expiry = record.expiry + CONSTANTS.TERM_LENGTH
      const status = expiry > tx.blockNumber ? 'REGISTERED' : record.status

      const draft = draftOf(state)
      draft.names.set(message.name, { ...record, expiry, status })
      draft.nextDueHeight = computeNextDue(draft)
      schedule(draft, expiry)
      return { state: freeze(draft), verdict: ok() }
    }

    // ── O — Offer (§6) ───────────────────────────────────────────────────────
    case 'O': {
      if (!addressEquals(tx.recipient, CONSTANTS.TREASURY_ADDRESS)) return keep(forfeit('WRONG_RECIPIENT'))
      const record = state.names.get(message.name)
      if (record === undefined || record.status !== 'REGISTERED') return keep(forfeit('NAME_NOT_REGISTERED'))
      if (!addressEquals(record.owner, tx.sender)) return keep(forfeit('NOT_OWNER'))

      // §6 `O`: the price MUST be ≥ MIN_PRICE, which is FEE_LONG **at this
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
      if (tx.value < CONSTANTS.LISTING_FEE) return keep(forfeit('INSUFFICIENT_VALUE'))

      const expiryHeight = tx.blockNumber + CONSTANTS.OFFER_MAX_LIFETIME
      const draft = draftOf(state)
      // A later O replaces the standing one and restarts its irrevocability.
      draft.offers.set(message.name, {
        name: message.name,
        seller: tx.sender,
        price: message.price,
        openedHeight: tx.blockNumber,
        expiryHeight,
      })
      schedule(draft, expiryHeight)
      return { state: freeze(draft), verdict: ok() }
    }

    // ── B — Buy (§6) ─────────────────────────────────────────────────────────
    case 'B': {
      if (!addressEquals(tx.recipient, CONSTANTS.MARKETPLACE_ADDRESS)) return keep(forfeit('WRONG_RECIPIENT'))

      const offer = state.offers.get(message.name)
      const record = state.names.get(message.name)
      // Covers the race loser, a cancelled or expired offer, and a bid against
      // an auction — which v1 never opens. All are refunded identically, so
      // the log does not need to tell them apart.
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
      // Not implemented in v1, by protocol version rather than by omission.
      // See the module docblock.
      //
      // §6 `A` gives the reserve the same MIN_PRICE floor as an `O` price, but
      // no `A` reaches that check in v1: §6 requires *every* `A` to take this
      // forfeit, so a below-floor one taking `BELOW_MIN_PRICE` instead would
      // put a different reason code in the log than a conforming
      // implementation. The floor is enforced in `encodeAuction`, and belongs
      // here — ahead of this line — on the version that activates auctions.
      return keep(forfeit('AUCTION_NOT_IN_V1'))
    }

    // ── P — Governance (§6, §10.6) ───────────────────────────────────────────
    case 'P': {
      if (!addressEquals(tx.recipient, CONSTANTS.PROTOCOL_ADDRESS)) return keep(forfeit('WRONG_RECIPIENT'))
      if (!addressEquals(tx.sender, CONSTANTS.ADMIN_ADDRESS)) return keep(forfeit('NOT_ADMIN'))
      if (message.effectiveHeight < tx.blockNumber + CONSTANTS.GOVERNANCE_DELAY) {
        return keep(forfeit('INSUFFICIENT_NOTICE'))
      }
      if (
        state.lastGovernanceHeight !== null &&
        tx.blockNumber - state.lastGovernanceHeight < CONSTANTS.PRICE_MIN_INTERVAL
      ) {
        return keep(forfeit('TOO_SOON'))
      }
      if (governanceBoundViolation(state.prices, message) !== null) return keep(forfeit('GOVERNANCE_BOUND_VIOLATED'))

      const draft = draftOf(state)
      draft.pendingGovernance = {
        prices: {
          feeStandard: message.feeStandard,
          feeLong: message.feeLong,
          commissionBp: message.commissionBp,
        },
        effectiveHeight: message.effectiveHeight,
      }
      draft.lastGovernanceHeight = tx.blockNumber
      schedule(draft, message.effectiveHeight)
      return { state: freeze(draft), verdict: ok() }
    }

    // ── U — Unreserve (§6) ───────────────────────────────────────────────────
    case 'U': {
      // Since r17 `U` has no recipient *routing* check: the recipient is an
      // operand — PROTOCOL_ADDRESS releases the name, any other address is
      // awarded it at effective_height — so it gets a row of its own rather
      // than the §5.3 check that precedes everything else (§7.4).
      if (!addressEquals(tx.sender, CONSTANTS.ADMIN_ADDRESS)) return keep(forfeit('NOT_ADMIN'))
      // The one forbidden recipient. BURN_ADDRESS has no key, and it is the
      // all-zero address §8.1 uses to encode *no* recipient — permitting it
      // would make an award to it and a release commit identical bytes (§6 U).
      if (addressEquals(tx.recipient, BURN_ADDRESS)) return keep(forfeit('INVALID_RECIPIENT'))
      if (message.effectiveHeight < tx.blockNumber + CONSTANTS.GOVERNANCE_DELAY) {
        return keep(forfeit('INSUFFICIENT_NOTICE'))
      }
      // §4.1 rules 2–5 and the ceiling — rule 6 is inverted by the row
      // after: a `U`'s name must be *in* RESERVED_NAMES. The floor never
      // binds a `U`: well-formed short names are reserved by rule (§4.1) and
      // are exactly what `U` exists to release or award, so RESERVED from
      // the full check is the expected case, not a failure. TOO_SHORT — a
      // short name failing rules 2–5, on neither membership route — still
      // forfeits here.
      const check = validateName(message.name, state.unreserved)
      if (!check.ok && check.reason !== 'RESERVED') return keep(forfeit('INVALID_NAME'))
      if (!isReserved(state, message.name)) return keep(forfeit('NAME_NOT_RESERVED'))
      // One pending U per name — this is what makes the effect at
      // effective_height unconditional rather than racing a sibling (§6 U).
      if (state.pendingUnreserve.has(message.name)) return keep(forfeit('UNRESERVE_PENDING'))

      const draft = draftOf(state)
      draft.pendingUnreserve.set(message.name, {
        name: message.name,
        recipient: addressEquals(tx.recipient, CONSTANTS.PROTOCOL_ADDRESS) ? null : tx.recipient,
        effectiveHeight: message.effectiveHeight,
      })
      schedule(draft, message.effectiveHeight)
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

/** Which §10.6 row a proposed `P` breaks. Diagnostic, never a log token. */
export type GovernanceBound =
  | 'PRICE_BAND'
  | 'ORDERING'
  | 'PRICE_MAX_FACTOR'
  | 'COMMISSION_CEILING'
  | 'COMMISSION_MAX_STEP'

export interface GovernanceBoundViolation {
  readonly bound: GovernanceBound
  /** The row, the numbers, and the limit — for a client to print before sending. */
  readonly message: string
}

/**
 * §10.6 bounds, enforced independently by every indexer. This is what makes a
 * compromised admin key "a slow, visible, bounded nuisance rather than a
 * catastrophe". `null` means every bound holds.
 *
 * Compared against the **active** prices rather than a pending `P`'s: with
 * `PRICE_MIN_INTERVAL` at ~7 d and `GOVERNANCE_DELAY` at ~12 h, a pending
 * change always activates before the next `P` is permitted, so the two
 * readings cannot diverge.
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
  proposed: { feeStandard: bigint; feeLong: bigint; commissionBp: bigint },
): GovernanceBoundViolation | null {
  const violation = (bound: GovernanceBound, message: string): GovernanceBoundViolation => ({ bound, message })

  const outOfBand = (label: string, fee: bigint): GovernanceBoundViolation | null =>
    fee >= CONSTANTS.PRICE_FLOOR && fee <= CONSTANTS.PRICE_CEILING
      ? null
      : violation(
          'PRICE_BAND',
          `${label} ${fee} is outside PRICE_FLOOR … PRICE_CEILING (${CONSTANTS.PRICE_FLOOR} … ${CONSTANTS.PRICE_CEILING} luna)`,
        )
  const standardBand = outOfBand('fee_standard', proposed.feeStandard)
  if (standardBand !== null) return standardBand
  const longBand = outOfBand('fee_long', proposed.feeLong)
  if (longBand !== null) return longBand

  if (proposed.feeLong > proposed.feeStandard) {
    return violation('ORDERING', `fee_long ${proposed.feeLong} must be <= fee_standard ${proposed.feeStandard}`)
  }

  // At most PRICE_MAX_FACTOR up or down, per band.
  const outOfFactor = (label: string, next: bigint, previous: bigint): GovernanceBoundViolation | null =>
    next <= previous * CONSTANTS.PRICE_MAX_FACTOR && next * CONSTANTS.PRICE_MAX_FACTOR >= previous
      ? null
      : violation(
          'PRICE_MAX_FACTOR',
          `${label} ${previous} → ${next} moves by more than PRICE_MAX_FACTOR (${CONSTANTS.PRICE_MAX_FACTOR}×), ` +
            // The lower end is a ceiling division: the rule is `next × FACTOR >= previous`,
            // so an odd `previous` permits one luna more than a floor would say.
            `so it must be within ${(previous + CONSTANTS.PRICE_MAX_FACTOR - 1n) / CONSTANTS.PRICE_MAX_FACTOR} … ${previous * CONSTANTS.PRICE_MAX_FACTOR} luna`,
        )
  const standardFactor = outOfFactor('fee_standard', proposed.feeStandard, current.feeStandard)
  if (standardFactor !== null) return standardFactor
  const longFactor = outOfFactor('fee_long', proposed.feeLong, current.feeLong)
  if (longFactor !== null) return longFactor

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
