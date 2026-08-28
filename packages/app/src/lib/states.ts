/**
 * Pure derivation of docs/app-states.md: the name view states (§1) and the
 * owner-action legality matrix (§4). No I/O, no React — tested directly.
 *
 * Gating is by state, never by owner-equality alone: a name in grace has an
 * owner who can renew but not repoint; a pending `X` leaves the owner in
 * control until maturity.
 */

import { CONSTANTS, feeBand, tryParseAddress } from '@nns/core'
import type { ApiParams, NameInfo } from './api'
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
 * of a failed fetch, which packages/app/CLAUDE.md gives to `resolve()` and
 * `available()` alone. It shipped as the default and offered **Register** on a
 * delegated subdomain — for the *parent*, whose `G` would have been forfeited
 * as `NAME_TAKEN` (Kike, 2026-08-28).
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

export type GateReason =
  | 'taken'
  | 'reserved'
  | 'in-grace'
  | 'no-record'
  | 'no-viewer'
  | 'not-owner'
  | 'nothing-to-cancel'
  | 'offer-irrevocable'
  | 'offer-open'
  | 'no-offer'
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

  const cancel = (): Gate => {
    const base = ownerGate()
    if (!base.enabled) {
      // Grace entry already cancelled everything cancellable (§7.3), so the
      // grace refusal is `nothing-to-cancel`, not `in-grace`.
      return view.kind === 'grace' ? closed('nothing-to-cancel') : base
    }
    const pending = info?.pending
    if (pending?.transfer) return open
    if (pending?.offer) {
      return head >= pending.offer.openedHeight + CONSTANTS.OFFER_IRREVOCABLE
        ? open
        : closed('offer-irrevocable')
    }
    return closed('nothing-to-cancel')
  }

  const renew = (): Gate =>
    // Anyone may renew, in term or in grace (§6 `N`); the record must exist.
    view.kind === 'registered' || view.kind === 'grace' ? open : closed('no-record')

  const offer = (): Gate => {
    const base = ownerGate()
    if (!base.enabled) return base
    return info?.pending.offer ? closed('offer-open') : open
  }

  const buy = (): Gate => {
    const pendingOffer = info?.pending.offer
    if (!pendingOffer) return closed('no-offer')
    return head < pendingOffer.expiryHeight ? open : closed('no-offer')
  }

  return {
    register: register(),
    setTarget: ownerGate(),
    setEvm: ownerGate(),
    transfer: ownerGate(),
    delegate: ownerGate(),
    cancel: cancel(),
    renew: renew(),
    offer: offer(),
    buy: buy(),
  }
}

/**
 * Which address signs an action, from the identity set. Owner-routed
 * actions must be signed by the owning address — the protocol checks the
 * sender — so the answer is the record's owner when the set holds it.
 * Anyone-actions (`G`, `N`, `B`, an NC message) sign with the set's
 * primary address.
 */
export function signerFor(action: AppAction, view: NameView, viewers: readonly string[]): string | null {
  const anyone = action === 'register' || action === 'renew' || action === 'buy'
  if (anyone) return viewers[0] ?? null
  const owner = view.info?.record?.owner
  if (owner === undefined) return null
  return viewers.find((viewer) => sameAddress(owner, viewer)) ?? null
}

// ── Clocks the UI must get right ────────────────────────────────────────────

export type RenewalUrgency = 'none' | 'due' | 'grace'

/** §10.4: the reminder fires from `GRACE_PERIOD × 2` (60 days) before expiry. */
export function renewalUrgency(expiry: number, head: number): RenewalUrgency {
  if (head >= expiry) return 'grace'
  if (head >= expiry - 2 * CONSTANTS.GRACE_PERIOD) return 'due'
  return 'none'
}

/** First height a `K` can withdraw this offer (half-open: cancellable **at** this height). */
export const offerCancellableAt = (openedHeight: number): number =>
  openedHeight + CONSTANTS.OFFER_IRREVOCABLE

export const offerExpiresAt = (openedHeight: number): number =>
  openedHeight + CONSTANTS.OFFER_MAX_LIFETIME

/** The exact §10.5 value a `G` or `N` for this name must carry, from `/params`. */
export function registrationFee(name: string, params: ApiParams): bigint {
  return feeBand(name) === 'STANDARD' ? params.prices.feeStandard : params.prices.feeLong
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
