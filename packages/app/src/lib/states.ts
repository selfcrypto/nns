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

export type NameViewKind = 'available' | 'registered' | 'grace' | 'reserved'

export interface NameView {
  readonly kind: NameViewKind
  readonly name: string
  readonly info: NameInfo | null
  /** Grace only: the first height a `G` can succeed (`expiry + GRACE_PERIOD`, half-open). */
  readonly availableAt: number | null
}

/** §1 of the states doc, from `/name/{name}` (or its 404, passed as null). */
export function nameView(name: string, info: NameInfo | null): NameView {
  if (info === null) return { kind: 'available', name, info: null, availableAt: null }
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

// ── Action legality (docs/app-states.md §4) ─────────────────────────────────

export type AppAction =
  | 'register'
  | 'setTarget'
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
  /** The wallet identity, or null outside Nimiq Pay. */
  readonly viewer: string | null
  /** Chain head as of the data being gated (API responses carry it). */
  readonly head: number
}

export function actionGates({ view, viewer, head }: GateContext): Record<AppAction, Gate> {
  const info = view.info
  const registeredRecord = view.kind === 'registered' && info?.record ? info.record : null
  const isOwner =
    registeredRecord !== null && viewer !== null && sameAddress(registeredRecord.owner, viewer)

  const ownerGate = (): Gate => {
    if (view.kind === 'grace') return closed('in-grace')
    if (registeredRecord === null) return closed('no-record')
    if (viewer === null) return closed('no-viewer')
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
    transfer: ownerGate(),
    delegate: ownerGate(),
    cancel: cancel(),
    renew: renew(),
    offer: offer(),
    buy: buy(),
  }
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
