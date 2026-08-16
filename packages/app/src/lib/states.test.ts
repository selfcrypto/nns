import { describe, expect, it } from 'vitest'
import { CONSTANTS } from '@nns/core'
import type { NameInfo } from './api'
import {
  actionGates,
  nameView,
  offerCancellableAt,
  registrationFee,
  renewalUrgency,
  sameAddress,
} from './states'

const OWNER = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000'
const OTHER = 'NQ34 248H 248H 248H 248H 248H 248H 248H 248H'

const info = (overrides: Partial<NameInfo> & { record?: NameInfo['record'] }): NameInfo => ({
  name: 'example',
  reserved: false,
  unreserved: false,
  record: null,
  pending: { transfer: null, offer: null },
  height: 1_000_000,
  ...overrides,
})

const registered = (over: Partial<NameInfo> = {}): NameInfo =>
  info({
    record: {
      name: 'example',
      owner: OWNER,
      target: OWNER,
      expiry: 2_000_000,
      status: 'REGISTERED',
      host: '',
    },
    ...over,
  })

const graceInfo = (): NameInfo =>
  info({
    record: {
      name: 'example',
      owner: OWNER,
      target: OWNER,
      expiry: 900_000,
      status: 'GRACE',
      host: '',
    },
  })

describe('nameView (app-states.md §1)', () => {
  it('a 404 is available', () => {
    expect(nameView('example', null).kind).toBe('available')
  })

  it('reserved with no record is reserved; released is available', () => {
    expect(nameView('example', info({ reserved: true })).kind).toBe('reserved')
    expect(nameView('example', info({ reserved: false, unreserved: true })).kind).toBe('available')
  })

  it('grace carries the first height a G can succeed — expiry + GRACE_PERIOD, half-open', () => {
    const view = nameView('example', graceInfo())
    expect(view.kind).toBe('grace')
    expect(view.availableAt).toBe(900_000 + CONSTANTS.GRACE_PERIOD)
  })
})

describe('actionGates (app-states.md §4)', () => {
  it('register: only on available — grace and reserved carry their own reasons', () => {
    expect(actionGates({ view: nameView('a', null), viewer: null, head: 0 }).register.enabled).toBe(true)
    expect(actionGates({ view: nameView('a', info({ reserved: true })), viewer: null, head: 0 }).register.reason).toBe('reserved')
    expect(actionGates({ view: nameView('a', graceInfo()), viewer: OWNER, head: 950_000 }).register.reason).toBe('in-grace')
    expect(actionGates({ view: nameView('a', registered()), viewer: OTHER, head: 0 }).register.reason).toBe('taken')
  })

  it('S/X/D require REGISTERED and the owner — never grace, never a non-owner', () => {
    const owned = actionGates({ view: nameView('a', registered()), viewer: OWNER, head: 1_000_000 })
    expect(owned.setTarget.enabled).toBe(true)
    expect(owned.transfer.enabled).toBe(true)
    expect(owned.delegate.enabled).toBe(true)

    const notOwner = actionGates({ view: nameView('a', registered()), viewer: OTHER, head: 1_000_000 })
    expect(notOwner.setTarget.reason).toBe('not-owner')

    const inGrace = actionGates({ view: nameView('a', graceInfo()), viewer: OWNER, head: 950_000 })
    expect(inGrace.setTarget.reason).toBe('in-grace')
    expect(inGrace.transfer.reason).toBe('in-grace')
    expect(inGrace.delegate.reason).toBe('in-grace')
  })

  it('a pending X leaves the owner in control: S stays legal', () => {
    const pendingTransfer = registered({
      pending: { transfer: { newOwner: OTHER, effectiveHeight: 1_040_000 }, offer: null },
    })
    const gates = actionGates({ view: nameView('a', pendingTransfer), viewer: OWNER, head: 1_000_000 })
    expect(gates.setTarget.enabled).toBe(true)
    expect(gates.cancel.enabled).toBe(true)
  })

  it('N is for anyone, in term or in grace — gone once the record is', () => {
    expect(actionGates({ view: nameView('a', registered()), viewer: null, head: 0 }).renew.enabled).toBe(true)
    expect(actionGates({ view: nameView('a', graceInfo()), viewer: null, head: 950_000 }).renew.enabled).toBe(true)
    expect(actionGates({ view: nameView('a', null), viewer: OWNER, head: 0 }).renew.reason).toBe('no-record')
  })

  it('K: the offer is cancellable at exactly openedHeight + OFFER_IRREVOCABLE, not a block before', () => {
    const opened = 1_000_000
    const withOffer = registered({
      pending: {
        transfer: null,
        offer: { name: 'a', seller: OWNER, price: 100_000n, openedHeight: opened, expiryHeight: opened + CONSTANTS.OFFER_MAX_LIFETIME },
      },
    })
    const boundary = offerCancellableAt(opened)
    expect(boundary).toBe(opened + CONSTANTS.OFFER_IRREVOCABLE)

    const before = actionGates({ view: nameView('a', withOffer), viewer: OWNER, head: boundary - 1 })
    expect(before.cancel.enabled).toBe(false)
    expect(before.cancel.reason).toBe('offer-irrevocable')

    const at = actionGates({ view: nameView('a', withOffer), viewer: OWNER, head: boundary })
    expect(at.cancel.enabled).toBe(true)
  })

  it('K in grace is nothing-to-cancel — grace entry already cleared the cancellable set', () => {
    const gates = actionGates({ view: nameView('a', graceInfo()), viewer: OWNER, head: 950_000 })
    expect(gates.cancel.reason).toBe('nothing-to-cancel')
  })

  it('O needs the owner and no open offer; a second O is offer-open, not a send', () => {
    const withOffer = registered({
      pending: {
        transfer: null,
        offer: { name: 'a', seller: OWNER, price: 100_000n, openedHeight: 1, expiryHeight: 2_000_000 },
      },
    })
    expect(actionGates({ view: nameView('a', registered()), viewer: OWNER, head: 0 }).offer.enabled).toBe(true)
    expect(actionGates({ view: nameView('a', withOffer), viewer: OWNER, head: 0 }).offer.reason).toBe('offer-open')
  })

  it('B needs an open, unexpired offer', () => {
    const withOffer = registered({
      pending: {
        transfer: null,
        offer: { name: 'a', seller: OWNER, price: 100_000n, openedHeight: 1, expiryHeight: 1_500_000 },
      },
    })
    expect(actionGates({ view: nameView('a', withOffer), viewer: OTHER, head: 1_000_000 }).buy.enabled).toBe(true)
    expect(actionGates({ view: nameView('a', withOffer), viewer: OTHER, head: 1_500_000 }).buy.reason).toBe('no-offer')
    expect(actionGates({ view: nameView('a', registered()), viewer: OTHER, head: 0 }).buy.reason).toBe('no-offer')
  })

  it('no wallet identity closes the owner actions with no-viewer, not not-owner', () => {
    const gates = actionGates({ view: nameView('a', registered()), viewer: null, head: 0 })
    expect(gates.setTarget.reason).toBe('no-viewer')
  })
})

describe('clocks', () => {
  it('the renewal reminder fires from GRACE_PERIOD × 2 before expiry (§10.4)', () => {
    const expiry = 10_000_000
    expect(renewalUrgency(expiry, expiry - 2 * CONSTANTS.GRACE_PERIOD - 1)).toBe('none')
    expect(renewalUrgency(expiry, expiry - 2 * CONSTANTS.GRACE_PERIOD)).toBe('due')
    expect(renewalUrgency(expiry, expiry)).toBe('grace')
  })

  it('registrationFee picks the band from the name length', () => {
    const params = {
      prices: { feeStandard: 200_000_000n, feeLong: 40_000_000n, commissionBp: 250n },
      minPrice: 40_000_000n,
      listingFee: 0n,
      pendingGovernance: null,
      height: 1,
    }
    expect(registrationFee('short', params)).toBe(200_000_000n)
    expect(registrationFee('averylongername', params)).toBe(40_000_000n)
  })
})

describe('sameAddress', () => {
  it('compares canonically, not textually', () => {
    expect(sameAddress(OWNER, OWNER.toLowerCase())).toBe(true)
    expect(sameAddress(OWNER, OTHER)).toBe(false)
    expect(sameAddress('not an address', OWNER)).toBe(false)
  })
})
