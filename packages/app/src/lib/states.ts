/**
 * Pure derivation of docs/app-states.md: the name view states (§1) and the
 * owner-action legality matrix (§4). No I/O, no React — tested directly.
 *
 * Gating is by state, never by owner-equality alone: a name in grace has an
 * owner who can renew but not repoint; a pending `X` leaves the owner in
 * control until maturity.
 */

import { CONSTANTS, tryParseAddress } from '@nimiqnames/core'
import type { ApiParams, FeeRow, NameInfo } from './api'
import type { Identity, WalletKind } from './identity'
import type { SearchOutcome } from './search'

export type NameViewKind = 'available' | 'registered' | 'grace' | 'reserved'

export interface NameView {
  readonly kind: NameViewKind
  readonly name: string
  readonly info: NameInfo | null
  /** Grace only: the first height a `G` can succeed (`expiry + GRACE_PERIOD`, half-open). */
  readonly availableAt: number | null
}

/**
 * §1 of the states doc, from `/name/{name}` (or its 404, passed as null).
 *
 * **`whenUnknown` is required, and it is not a default.** `/name` is an
 * *overlay* — `lib/search.ts` fetches it best-effort and swallows its failure,
 * and never fetches it at all for a dotted query. A null info therefore means
 * "not asked, or the ask failed", which is not a state and above all is not
 * `available`: reading it as one is the app minting an availability verdict out
 * of a failed fetch, which this package gives to `resolve()` and
 * `available()` alone. It shipped as the default and offered **Register** on a
 * delegated subdomain — for the *parent*, whose `G` would have been forfeited
 * as `NAME_TAKEN` (Rico, 2026-08-28).
 *
 * So the caller passes what the resolver already established: a name that
 * resolved is `registered`, one `available()` cleared is `available`, one that
 * threw `IN_GRACE` is `grace`.
 */
export function nameView(name: string, info: NameInfo | null, whenUnknown: NameViewKind): NameView {
  if (info === null) return { kind: whenUnknown, name, info: null, availableAt: null }
  if (info.record === null) {
    return info.reserved
      ? { kind: 'reserved', name, info, availableAt: null }
      : { kind: 'available', name, info, availableAt: null }
  }
  if (info.record.status === 'GRACE') {
    return {
      kind: 'grace',
      name,
      info,
      availableAt: info.record.expiry + CONSTANTS.GRACE_PERIOD,
    }
  }
  return { kind: 'registered', name, info, availableAt: null }
}

/**
 * The view a search outcome offers actions on — **`null` when it offers none**,
 * which is a real answer and not an absence:
 *
 * - A **dotted query** (§8.6). What is on screen is a label, and every action
 *   in `AppAction` takes a *name*; the only name in a delegated answer is the
 *   parent, which resolved, so it is held. The card that read the outcome's
 *   `name` field offered to register that parent — a `G` the reducer forfeits
 *   as `NAME_TAKEN`. Whether the label exists is the host's word and NNS's
 *   business nowhere (states doc §5 #4).
 * - An unavailable name, an unreachable resolver, a delegate that failed, an
 *   alarm: nothing on those cards is an object to act on.
 *
 * Here rather than in the component because the package's Vitest environment is
 * `node`: a rule a component decides for itself is a rule with untested
 * branches, and this one shipped wrong.
 */
export function viewFor(outcome: SearchOutcome): NameView | null {
  switch (outcome.kind) {
    case 'resolved':
      return outcome.result.delegate !== null
        ? null
        : nameView(outcome.info?.name ?? outcome.result.name, outcome.info, 'registered')
    case 'availability':
      return outcome.availability.available ? nameView(outcome.name, outcome.info, 'available') : null
    case 'grace':
      return nameView(outcome.name, outcome.info, 'grace')
    default:
      return null
  }
}

// ── Action legality (docs/app-states.md §4) ─────────────────────────────────

export type AppAction =
  | 'register'
  | 'setTarget'
  | 'setEvm'
  | 'transfer'
  | 'delegate'
  | 'cancel'
  | 'renew'
  | 'offer'
  | 'buy'
  /** `A` — the owner opens a bidding window (r28). */
  | 'auction'
  /** A `B` on a name under auction: the same message as `buy`, read as a bid by state (§6 `A`). */
  | 'bid'

export type GateReason =
  | 'taken'
  | 'reserved'
  | 'in-grace'
  | 'no-record'
  | 'no-viewer'
  | 'not-owner'
  | 'nothing-to-cancel'
  /** One pending thing per name (§7.3, r30): `X`, `O` and `A` all close on whichever of the three stands. */
  | 'offer-open'
  | 'transfer-pending'
  | 'no-offer'
  /** The third: and the one a `K` cannot lift, so it stays closed for the cancel tile too. */
  | 'auction-open'
  | 'no-auction'
  /** The name resolved, but `/name` did not answer — no record to act on. */
  | 'state-unknown'

export interface Gate {
  readonly enabled: boolean
  readonly reason: GateReason | null
}

const open: Gate = { enabled: true, reason: null }
const closed = (reason: GateReason): Gate => ({ enabled: false, reason })

export function sameAddress(a: string, b: string): boolean {
  const left = tryParseAddress(a)
  const right = tryParseAddress(b)
  return left !== null && right !== null && left === right
}

export interface GateContext {
  readonly view: NameView
  /**
   * The wallet identity as a **set of addresses** — Pay supplies a set of
   * one, Hub grows one per connect, empty means no wallet. Owner actions
   * are legal when **any** address in the set owns the record; which one
   * signs is `signerFor`, never an assumption.
   */
  readonly viewers: readonly string[]
  /** Chain head as of the data being gated (API responses carry it). */
  readonly head: number
}

export function actionGates({ view, viewers, head }: GateContext): Record<AppAction, Gate> {
  const info = view.info
  const registeredRecord = view.kind === 'registered' && info?.record ? info.record : null
  const isOwner =
    registeredRecord !== null && viewers.some((viewer) => sameAddress(registeredRecord.owner, viewer))

  const ownerGate = (): Gate => {
    if (view.kind === 'grace') return closed('in-grace')
    // Registered but no record in hand: the overlay failed. Say that, rather
    // than "this name isn't registered" under a name that just resolved.
    if (view.kind === 'registered' && info === null) return closed('state-unknown')
    if (registeredRecord === null) return closed('no-record')
    if (viewers.length === 0) return closed('no-viewer')
    if (!isOwner) return closed('not-owner')
    return open
  }

  const register = (): Gate => {
    switch (view.kind) {
      case 'available':
        return open
      case 'reserved':
        return closed('reserved')
      case 'grace':
        return closed('in-grace')
      case 'registered':
        return closed('taken')
    }
  }

  /**
   * One pending thing per name (§7.3, r30): a transfer, a sale or an auction.
   * A message of another kind forfeits while one stands, so the tile closes
   * on whichever it is; the same kind replaces it, so Transfer stays open on
   * a transferring name (a retarget) and Sell on a listed one (a reprice).
   * The way across kinds is the cancel tile, except for an auction, which
   * runs to its close.
   */
  const busy = (): GateReason | null => {
    const pending = info?.pending
    if (pending?.auction) return 'auction-open'
    if (pending?.offer) return 'offer-open'
    if (pending?.transfer) return 'transfer-pending'
    return null
  }
  const opener = (ownKind: GateReason | null = null): Gate => {
    const base = ownerGate()
    if (!base.enabled) return base
    const reason = busy()
    return reason === null || reason === ownKind ? open : closed(reason)
  }

  const cancel = (): Gate => {
    const base = ownerGate()
    if (!base.enabled) {
      // Grace entry already cancelled everything cancellable (§7.3), so the
      // grace refusal is `nothing-to-cancel`, not `in-grace`.
      return view.kind === 'grace' ? closed('nothing-to-cancel') : base
    }
    // The one pending thing a `K` cannot clear: say which, rather than
    // "nothing is pending". A transfer or a sale clears at any height.
    switch (busy()) {
      case 'auction-open':
        return closed('auction-open')
      case null:
        return closed('nothing-to-cancel')
      default:
        return open
    }
  }

  const renew = (): Gate =>
    // Anyone may renew, in term or in grace (§6 `N`); the record must exist.
    view.kind === 'registered' || view.kind === 'grace' ? open : closed('no-record')

  const buy = (): Gate => {
    const pendingOffer = info?.pending.offer
    if (!pendingOffer) return closed('no-offer')
    return head < pendingOffer.expiryHeight ? open : closed('no-offer')
  }

  const bid = (): Gate => {
    const pendingAuction = info?.pending.auction
    if (!pendingAuction) return closed('no-auction')
    // A listed auction is open — the close is a height effect and the row is
    // gone at `endHeight` — but the height the data carries is checked
    // anyway, as `buy` checks an offer's expiry.
    return head < pendingAuction.endHeight ? open : closed('no-auction')
  }

  return {
    register: register(),
    setTarget: ownerGate(),
    setEvm: ownerGate(),
    transfer: opener('transfer-pending'),
    delegate: ownerGate(),
    cancel: cancel(),
    renew: renew(),
    offer: opener('offer-open'),
    buy: buy(),
    auction: opener(),
    bid: bid(),
  }
}

/**
 * Which address signs an action, from the identity set. Owner-routed
 * actions must be signed by the owning address — the protocol checks the
 * sender — so the answer is the record's owner when the set holds it.
 * Anyone-actions (`G`, `N`, `B` as a buy or a bid, an NC message) sign with
 * the set's primary address. Every screen passes `actingAs` — the one picked
 * address — so both answers are that address or nothing (`lib/identity.ts`).
 */
export function signerFor(action: AppAction, view: NameView, viewers: readonly string[]): string | null {
  const anyone = action === 'register' || action === 'renew' || action === 'buy' || action === 'bid'
  if (anyone) return viewers[0] ?? null
  const owner = view.info?.record?.owner
  if (owner === undefined) return null
  return viewers.find((viewer) => sameAddress(owner, viewer)) ?? null
}

// ── Clocks the UI must get right ────────────────────────────────────────────

export type RenewalUrgency = 'none' | 'due' | 'grace'

/**
 * §10.4: how long before expiry the renewal reminder starts, `GRACE_PERIOD ×
 * 2` — 60 days on the mainnet constants, and a couple of days on a compressed
 * era. Exported because the docs quote the figure (`{{dur:RENEW_WINDOW}}`) and
 * a typed "60 days" there is wrong on every era but one.
 */
export const RENEW_WINDOW: number = 2 * CONSTANTS.GRACE_PERIOD

export function renewalUrgency(expiry: number, head: number): RenewalUrgency {
  if (head >= expiry) return 'grace'
  if (head >= expiry - RENEW_WINDOW) return 'due'
  return 'none'
}

export const offerExpiresAt = (openedHeight: number): number =>
  openedHeight + CONSTANTS.OFFER_MAX_LIFETIME

/**
 * What a `K` sent now would clear (§6 `K`): the name's one pending thing, or
 * nothing — an auction is pending and never cancellable, and since r30 nothing
 * else can stand beside it or beside anything. One reading, shared by the
 * tile, the sheet's label, its review and the confirm poll.
 */
export type Cancellable = 'transfer' | 'sale' | null

export const cancellable = (info: NameInfo | null): Cancellable => {
  const pending = info?.pending
  if (pending?.transfer) return 'transfer'
  if (pending?.offer) return 'sale'
  return null
}

/**
 * Which owner-tile group the cancel tile belongs in — it sits beside what it
 * would act on. A `K` whose whole effect is vetoing a transfer has nothing to
 * do with the marketplace, and under that heading it read as one: the tile was
 * fixed in `market` and called itself a listing.
 *
 * Here rather than inline in the component for the reason packages/app's
 * rule: a branch a component decides for itself is an untested one.
 */
export const cancelTileGroup = (set: Cancellable): 'ownership' | 'market' => (set === 'transfer' ? 'ownership' : 'market')

/**
 * Blocks the Auction sheet adds between the head it planned against and the
 * start of the duration the owner typed (~1 h). Client policy, not protocol.
 *
 * §6 `A` measures `AUCTION_MIN_DURATION` from the block the message **lands
 * in**; the app only knows the API's height, which trails the chain by up to
 * a batch, plus the wallet sheet, the mempool and the user reading the
 * review. An end at exactly `head + duration` therefore forfeits
 * `INSUFFICIENT_NOTICE` unless the message lands at once — for a duration
 * typed as the minimum, which is the one people type. The margin goes on
 * top of the duration rather than into a floor on it, so "1 day" is a
 * legal auction that runs about a day from landing and the review shows the
 * real end; the same hour `packages/admin`'s `p` adds above a `P`'s notice.
 */
export const AUCTION_LANDING_MARGIN = 3_600

/** Where an auction opened now against `head` ends, for a duration the owner chose in blocks. */
export const auctionEndHeight = (head: number, durationBlocks: number): number =>
  head + AUCTION_LANDING_MARGIN + durationBlocks

/**
 * §6 `A` has no rule against an end at or past expiry — the §7.3 grace reset
 * cancels the auction and refunds the standing bid instead, so the client
 * warns and the owner renews first. Half-open: the name is in `GRACE` **at**
 * `expiry`, so an end there is already past the last resolving block.
 */
export const auctionOutlivesTerm = (endHeight: number, expiry: number): boolean => endHeight >= expiry

/**
 * The §10.1 band that prices this name: the first row its length fits. The
 * rows are `/params.fees`, priced by the api through core — the app reads a
 * figure off the table and never multiplies.
 */
export function feeRowFor(name: string, fees: readonly FeeRow[]): FeeRow {
  const row = fees.find((band) => name.length <= band.upTo)
  if (row === undefined) throw new Error(`no fee band covers a ${name.length}-character name`)
  return row
}

/** The exact §10.5 value a `G` or `N` for this name must carry, from `/params` — for a term, or a lifetime (§10.4). */
export function registrationFee(name: string, params: ApiParams, lifetime = false): bigint {
  const row = feeRowFor(name, params.fees)
  return lifetime ? row.lifetime : row.yearly
}

// ── Can this wallet pay at all? ─────────────────────────────────────────────

export interface Shortfall {
  readonly owed: bigint
  /** The best any one of the wallet's accounts holds. */
  readonly held: bigint
}

/**
 * Whether the send is knowably unpayable, from the balances of every account
 * the wallet may sign with. `null` means "do not stand in the way" — either
 * it can pay, or we do not know.
 *
 * **The maximum, not the sum.** A transaction spends one account, and on the
 * Pay path `SubmitRequest.sender` is not even consulted: `paySendTransaction`
 * takes no sender and the wallet signs with whichever address holds the
 * balance. So the question is whether *some* account could cover the value,
 * and summing the set would pass a wallet where no single account can pay.
 *
 * **A partial reading refuses nothing.** One address the endpoint would not
 * answer for leaves the set's maximum unknown, and a broken balance check is
 * never a negative result — the same rule `performSend`'s confirm loop runs
 * on. Blocking a send on a flaky read is the worse of the two mistakes.
 *
 * This exists because it did not: an account short of the value signs a
 * transaction the network will never include, and the confirm loop then
 * reports the drop as vaguely as it can. A friend's 200 NIM registration
 * from a 0 NIM wallet spent four minutes on a spinner to reach "it may well
 * have gone through" (2026-09-14). The number is one allowlisted call away
 * before the wallet ever opens.
 */
export function shortfallFor(owed: bigint | null, balances: readonly (bigint | null)[]): Shortfall | null {
  if (owed === null) return null
  const held = mostHeld(balances)
  return held !== null && held < owed ? { owed, held } : null
}

/**
 * The most any one account of the set holds — what a wallet that picks its
 * own signer can put in a single transaction. `shortfallFor`'s reading rule,
 * shared with Pay's MAX: the Remote wallet keeps the NIM in the HTLC contract
 * the identity drops, so the chosen sender's own balance there is dust while
 * the badge, summed over the raw set, shows the real number (Rico,
 * 2026-09-17: 8,470 NIM in the badge, MAX 1.6). `null` on an empty or
 * incomplete reading, for the same reason `shortfallFor` refuses nothing on
 * one.
 */
export function mostHeld(balances: readonly (bigint | null)[]): bigint | null {
  if (balances.length === 0 || balances.some((balance) => balance === null)) return null
  return balances.reduce((most: bigint, balance) => (balance !== null && balance > most ? balance : most), 0n)
}

// ── The identity row (docs/app-ux.md §1) ────────────────────────────────────

/**
 * What the row above the tab bar shows. Pure, because the package's Vitest
 * environment is `node` and a component that decides for itself is a component
 * with untested branches — which is exactly how a missing Disconnect went
 * unnoticed until a user reported it from a phone.
 *
 * `checking` is a state in its own right, not an absence: rendering nothing
 * while `detectWallet` is in flight is indistinguishable, on screen, from a
 * control that is broken.
 */
export type IdentityRow =
  | { readonly kind: 'checking' }
  | { readonly kind: 'connect'; readonly host: WalletKind }
  | {
      readonly kind: 'connected'
      readonly host: WalletKind
      readonly primary: string
      readonly more: number
      readonly canAdd: boolean
      readonly canDisconnect: boolean
    }

export function identityRow(
  wallet: {
    readonly identity: Identity
    readonly connect: unknown | null
    readonly disconnect: unknown | null
  } | null,
): IdentityRow {
  if (wallet === null) return { kind: 'checking' }
  const { kind, addresses } = wallet.identity
  const primary = addresses[0]
  if (primary === undefined) return { kind: 'connect', host: kind }
  return {
    kind: 'connected',
    host: kind,
    primary,
    more: addresses.length - 1,
    // Only the Hub grows its set an address at a time; Pay's is the host's,
    // whole, and asking again cannot add to it.
    canAdd: kind === 'hub' && wallet.connect !== null,
    canDisconnect: wallet.disconnect !== null,
  }
}

/**
 * Whether a screen holding an action should draw the identity control where
 * the action would be. Two states answer yes: detection in flight, which
 * `IdentityBar` draws as "Checking wallet…", and a wallet with no address,
 * which it draws as the Connect button.
 *
 * It exists because every screen was asking `wallet === null`, and that is the
 * *first* state, not the second. The Hub adapter hands back a wallet before
 * anybody has connected — a real object whose address set is empty — so the
 * test was false exactly when a user needed the button, and Pay's card said
 * "Connect a wallet to act on names" with nothing on it to press (Rico,
 * 2026-09-14, on the deployed app).
 *
 * `canConnect` is whether the screen has a connect handler at all. Without one
 * there is nothing to draw in the `connect` state, so the caller keeps
 * whatever it says today rather than rendering an empty row.
 */
export function connectInstead(
  wallet: Parameters<typeof identityRow>[0],
  canConnect: boolean,
): boolean {
  const { kind } = identityRow(wallet)
  return kind === 'checking' || (kind === 'connect' && canConnect)
}
