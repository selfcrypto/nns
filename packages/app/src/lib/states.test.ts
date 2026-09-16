import { describe, expect, it } from 'vitest'
import { CONSTANTS } from '@nimiqnames/core'
import type { NameInfo } from './api'
import type { Identity } from './identity'
import { parseAddress } from '@nimiqnames/core'
import type { ResolveResult } from '@nimiqnames/resolver'
import type { SearchOutcome } from './search'
import {
  actionGates,
  cancelTileGroup,
  cancellable,
  connectInstead,
  identityRow,
  nameView,
  feeRowFor,
  registrationFee,
  shortfallFor,
  renewalUrgency,
  sameAddress,
  viewFor,
} from './states'
import * as states from './states'

const OWNER = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000'
const OTHER = 'NQ34 248H 248H 248H 248H 248H 248H 248H 248H'

const info = (overrides: Partial<NameInfo> & { record?: NameInfo['record'] }): NameInfo => ({
  name: 'example',
  reserved: false,
  unreserved: false,
  record: null,
  pending: { transfer: null, offer: null, auction: null },
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
      evm: '',
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
      evm: '',
      host: '',
    },
  })

describe('nameView (app-states.md §1)', () => {
  it('a 404 is available — because the caller says so, not because info is null', () => {
    expect(nameView('example', null, 'available').kind).toBe('available')
  })

  // The overlay is best-effort (`lib/search.ts` swallows its failure and never
  // asks for it at all on a dotted query), so a null info is "not known", and
  // reading it as `available` is how a delegated subdomain came to be offered
  // for registration.
  it('a missing overlay is whatever the caller already established, never available by default', () => {
    expect(nameView('example', null, 'registered').kind).toBe('registered')
    expect(nameView('example', null, 'grace').kind).toBe('grace')
    expect(actionGates({ view: nameView('example', null, 'registered'), viewers: [OWNER], head: 0 }).register).toEqual({
      enabled: false,
      reason: 'taken',
    })
  })

  it('a registered name with no record in hand refuses owner actions as unknown, not as unregistered', () => {
    const gates = actionGates({ view: nameView('example', null, 'registered'), viewers: [OWNER], head: 0 })
    expect(gates.setTarget).toEqual({ enabled: false, reason: 'state-unknown' })
    expect(gates.transfer.reason).toBe('state-unknown')
  })

  it('reserved with no record is reserved; released is available', () => {
    expect(nameView('example', info({ reserved: true }), 'available').kind).toBe('reserved')
    expect(nameView('example', info({ reserved: false, unreserved: true }), 'available').kind).toBe('available')
  })

  it('grace carries the first height a G can succeed — expiry + GRACE_PERIOD, half-open', () => {
    const view = nameView('example', graceInfo(), 'available')
    expect(view.kind).toBe('grace')
    expect(view.availableAt).toBe(900_000 + CONSTANTS.GRACE_PERIOD)
  })
})

const resolveResult = (over: Partial<ResolveResult> = {}): ResolveResult => ({
  query: 'example',
  name: 'example',
  address: parseAddress(OWNER),
  evm: '',
  verification: 'PROVEN',
  host: '',
  checkpoint: null,
  height: 1_000_000,
  delegate: null,
  quorum: { required: 1, queried: 1, agreed: 1, resolvers: [{ name: 'op', url: 'https://api.example.com', ms: 12 }] },
  anchor: { status: 'not-checked', detail: '', check: null, reason: 'NOT_CONFIGURED' },
  warnings: [],
  ...over,
})

describe('viewFor — which outcomes carry an actionable name', () => {
  /**
   * The bug this exists for (Kike, 2026-08-28): `rico.nns` resolved through
   * `nns`'s delegate and the card offered **Register**. There is no label to
   * register — the `G` would have gone out for the *parent*, which resolved and
   * is therefore held, and the reducer forfeits that fee as `NAME_TAKEN`.
   */
  it('a delegated answer has no actionable name at all', () => {
    const outcome: SearchOutcome = {
      kind: 'resolved',
      result: resolveResult({
        query: 'rico.nns',
        name: 'nns',
        delegate: { parent: 'nns', label: 'rico', host: 'nns.example.com', ttl: 300 },
      }),
      info: null,
    }
    expect(viewFor(outcome)).toBeNull()
  })

  it('a plain name that resolved is registered — never available, however the overlay went', () => {
    const outcome: SearchOutcome = { kind: 'resolved', result: resolveResult(), info: null }
    const view = viewFor(outcome)
    expect(view?.kind).toBe('registered')
    expect(actionGates({ view: view!, viewers: [], head: 0 }).register.reason).toBe('taken')
  })

  it('availability carries the verdict `available()` gave, and nothing when it refused', () => {
    const base = { kind: 'availability', name: 'example', info: null } as const
    expect(
      viewFor({
        ...base,
        availability: { name: 'example', available: true, reason: null, verification: 'PROVEN', checkpoint: null, height: 1, quorum: { required: 1, queried: 1, agreed: 1, resolvers: [{ name: 'op', url: 'https://api.example.com', ms: 12 }] }, anchor: { status: 'not-checked', detail: '', check: null, reason: 'NOT_CONFIGURED' }, warnings: [] },
      })?.kind,
    ).toBe('available')
    expect(
      viewFor({
        ...base,
        availability: { name: 'example', available: false, reason: 'RESERVED', verification: 'PROVEN', checkpoint: null, height: 1, quorum: { required: 1, queried: 1, agreed: 1, resolvers: [{ name: 'op', url: 'https://api.example.com', ms: 12 }] }, anchor: { status: 'not-checked', detail: '', check: null, reason: 'NOT_CONFIGURED' }, warnings: [] },
      }),
    ).toBeNull()
  })

  it('nothing to act on where there is no name: a failed delegate, an alarm', () => {
    expect(viewFor({ kind: 'delegate-failed', query: 'rico.nns', code: 'DELEGATE_FAILED', parent: null })).toBeNull()
    expect(viewFor({ kind: 'alarm', code: 'ANCHOR_MISMATCH', message: '', replies: [] })).toBeNull()
  })
})

describe('actionGates (app-states.md §4)', () => {
  it('register: only on available — grace and reserved carry their own reasons', () => {
    expect(actionGates({ view: nameView('a', null, 'available'), viewers: [], head: 0 }).register.enabled).toBe(true)
    expect(actionGates({ view: nameView('a', info({ reserved: true }), 'available'), viewers: [], head: 0 }).register.reason).toBe('reserved')
    expect(actionGates({ view: nameView('a', graceInfo(), 'available'), viewers: [OWNER], head: 950_000 }).register.reason).toBe('in-grace')
    expect(actionGates({ view: nameView('a', registered(), 'available'), viewers: [OTHER], head: 0 }).register.reason).toBe('taken')
  })

  it('S/X/D require REGISTERED and the owner — never grace, never a non-owner', () => {
    const owned = actionGates({ view: nameView('a', registered(), 'available'), viewers: [OWNER], head: 1_000_000 })
    expect(owned.setTarget.enabled).toBe(true)
    expect(owned.transfer.enabled).toBe(true)
    expect(owned.delegate.enabled).toBe(true)

    const notOwner = actionGates({ view: nameView('a', registered(), 'available'), viewers: [OTHER], head: 1_000_000 })
    expect(notOwner.setTarget.reason).toBe('not-owner')

    const inGrace = actionGates({ view: nameView('a', graceInfo(), 'available'), viewers: [OWNER], head: 950_000 })
    expect(inGrace.setTarget.reason).toBe('in-grace')
    expect(inGrace.transfer.reason).toBe('in-grace')
    expect(inGrace.delegate.reason).toBe('in-grace')
  })

  it('a pending X leaves the owner in control: S stays legal', () => {
    const pendingTransfer = registered({
      pending: { transfer: { newOwner: OTHER, effectiveHeight: 1_040_000 }, offer: null, auction: null },
    })
    const gates = actionGates({ view: nameView('a', pendingTransfer, 'available'), viewers: [OWNER], head: 1_000_000 })
    expect(gates.setTarget.enabled).toBe(true)
    expect(gates.cancel.enabled).toBe(true)
  })

  it('N is for anyone, in term or in grace — gone once the record is', () => {
    expect(actionGates({ view: nameView('a', registered(), 'available'), viewers: [], head: 0 }).renew.enabled).toBe(true)
    expect(actionGates({ view: nameView('a', graceInfo(), 'available'), viewers: [], head: 950_000 }).renew.enabled).toBe(true)
    expect(actionGates({ view: nameView('a', null, 'available'), viewers: [OWNER], head: 0 }).renew.reason).toBe('no-record')
  })

  it('K: a sale is cancellable at once — there is no window (r30 fold)', () => {
    const opened = 1_000_000
    const withOffer = registered({
      pending: {
        transfer: null,
        offer: { name: 'a', seller: OWNER, price: 100_000n, openedHeight: opened, expiryHeight: opened + CONSTANTS.OFFER_MAX_LIFETIME },
        auction: null,
      },
    })
    expect(actionGates({ view: nameView('a', withOffer, 'available'), viewers: [OWNER], head: opened }).cancel.enabled).toBe(true)
    expect(actionGates({ view: nameView('a', withOffer, 'available'), viewers: [OWNER], head: opened + 1 }).cancel.enabled).toBe(true)
    expect(cancellable(withOffer)).toBe('sale')
  })

  it('K on a name under auction is auction-open, not nothing-to-cancel', () => {
    const underAuction = registered({
      pending: {
        transfer: null,
        offer: null,
        auction: { name: 'a', seller: OWNER, startingPrice: 1n, endHeight: 1_100_000, bidder: null, bid: 0n, minimumBid: 1n },
      },
    })
    expect(actionGates({ view: nameView('a', underAuction, 'available'), viewers: [OWNER], head: 0 }).cancel.reason).toBe('auction-open')
    expect(cancellable(underAuction)).toBeNull()
  })

  it('K in grace is nothing-to-cancel — grace entry already cleared the cancellable set', () => {
    const gates = actionGates({ view: nameView('a', graceInfo(), 'available'), viewers: [OWNER], head: 950_000 })
    expect(gates.cancel.reason).toBe('nothing-to-cancel')
  })

  it('O needs the owner and no open offer; a second O is offer-open, not a send', () => {
    const withOffer = registered({
      pending: {
        transfer: null,
        offer: { name: 'a', seller: OWNER, price: 100_000n, openedHeight: 1, expiryHeight: 2_000_000 },
        auction: null,
      },
    })
    expect(actionGates({ view: nameView('a', registered(), 'available'), viewers: [OWNER], head: 0 }).offer.enabled).toBe(true)
    expect(actionGates({ view: nameView('a', withOffer, 'available'), viewers: [OWNER], head: 0 }).offer.reason).toBe('offer-open')
  })

  it('B needs an open, unexpired offer', () => {
    const withOffer = registered({
      pending: {
        transfer: null,
        offer: { name: 'a', seller: OWNER, price: 100_000n, openedHeight: 1, expiryHeight: 1_500_000 },
        auction: null,
      },
    })
    expect(actionGates({ view: nameView('a', withOffer, 'available'), viewers: [OTHER], head: 1_000_000 }).buy.enabled).toBe(true)
    expect(actionGates({ view: nameView('a', withOffer, 'available'), viewers: [OTHER], head: 1_500_000 }).buy.reason).toBe('no-offer')
    expect(actionGates({ view: nameView('a', registered(), 'available'), viewers: [OTHER], head: 0 }).buy.reason).toBe('no-offer')
  })

  describe('an open auction is exclusive (§6 `A`, r28)', () => {
    const auction = { name: 'a', seller: OWNER, startingPrice: 100_000n, endHeight: 1_100_000, bidder: null, bid: 0n, minimumBid: 100_000n }
    const underAuction = registered({ pending: { transfer: null, offer: null, auction } })

    it('A needs the owner and nothing pending', () => {
      expect(actionGates({ view: nameView('a', registered(), 'available'), viewers: [OWNER], head: 0 }).auction.enabled).toBe(true)
      expect(actionGates({ view: nameView('a', registered(), 'available'), viewers: [OTHER], head: 0 }).auction.reason).toBe('not-owner')
      expect(actionGates({ view: nameView('a', underAuction, 'available'), viewers: [OWNER], head: 0 }).auction.reason).toBe('auction-open')
    })

    it('O, X and K close on auction-open; S, E, D, N stay open', () => {
      const gates = actionGates({ view: nameView('a', underAuction, 'available'), viewers: [OWNER], head: 1_000_000 })
      expect(gates.offer.reason).toBe('auction-open')
      expect(gates.transfer.reason).toBe('auction-open')
      // Not "nothing to cancel": something is pending, and it is the thing K cannot touch.
      expect(gates.cancel.reason).toBe('auction-open')
      expect(gates.setTarget.enabled).toBe(true)
      expect(gates.setEvm.enabled).toBe(true)
      expect(gates.delegate.enabled).toBe(true)
      expect(gates.renew.enabled).toBe(true)
    })

    it('bid needs an open auction whose end the data has not reached; buy is no-offer meanwhile', () => {
      expect(actionGates({ view: nameView('a', underAuction, 'available'), viewers: [OTHER], head: 1_000_000 }).bid.enabled).toBe(true)
      expect(actionGates({ view: nameView('a', underAuction, 'available'), viewers: [OTHER], head: 1_100_000 }).bid.reason).toBe('no-auction')
      expect(actionGates({ view: nameView('a', registered(), 'available'), viewers: [OTHER], head: 0 }).bid.reason).toBe('no-auction')
      expect(actionGates({ view: nameView('a', underAuction, 'available'), viewers: [OTHER], head: 1_000_000 }).buy.reason).toBe('no-offer')
    })

    it('bid is an anyone-action: it signs with the primary address', async () => {
      const { signerFor } = await import('./states')
      expect(signerFor('bid', nameView('a', underAuction, 'available'), [OTHER, OWNER])).toBe(OTHER)
      expect(signerFor('auction', nameView('a', underAuction, 'available'), [OTHER, OWNER])).toBe(OWNER)
    })
  })

  describe('one pending thing per name (§7.3, r30)', () => {
    // A transfer, a sale or an auction: the three opener tiles close on
    // whichever stands, with the reason naming it, and the cancel tile is the
    // way out for two of the three.
    const HEAD = 1_000_000
    const transfer = { newOwner: OTHER, effectiveHeight: HEAD + 40_000 }
    const offer = { name: 'a', seller: OWNER, price: 100_000n, openedHeight: HEAD, expiryHeight: HEAD + CONSTANTS.OFFER_MAX_LIFETIME }
    const auction = { name: 'a', seller: OWNER, startingPrice: 1n, endHeight: HEAD + 100_000, bidder: null, bid: 0n, minimumBid: 1n }
    const standing = [
      { kind: 'transfer', info: registered({ pending: { transfer, offer: null, auction: null } }), reason: 'transfer-pending', cancels: 'transfer' },
      { kind: 'sale', info: registered({ pending: { transfer: null, offer, auction: null } }), reason: 'offer-open', cancels: 'sale' },
      { kind: 'auction', info: registered({ pending: { transfer: null, offer: null, auction } }), reason: 'auction-open', cancels: null },
    ] as const
    const openers = ['transfer', 'offer', 'auction'] as const

    for (const stands of standing) {
      it(`with a ${stands.kind} pending, Transfer, Sell and Auction all close on ${stands.reason}`, () => {
        const gates = actionGates({ view: nameView('a', stands.info, 'available'), viewers: [OWNER], head: HEAD + 1 })
        for (const tile of openers) expect(gates[tile], tile).toEqual({ enabled: false, reason: stands.reason })
        // The owner keeps the record: `S`, `E`, `D` and `N` are unaffected.
        expect(gates.setTarget.enabled).toBe(true)
        expect(gates.renew.enabled).toBe(true)
      })

      it(`with a ${stands.kind} pending, a stranger is told they are a stranger`, () => {
        const gates = actionGates({ view: nameView('a', stands.info, 'available'), viewers: [OTHER], head: HEAD + 1 })
        for (const tile of openers) expect(gates[tile].reason, tile).toBe('not-owner')
      })

      it(`with a ${stands.kind} pending, the cancel tile ${stands.cancels === null ? 'is closed on auction-open' : `clears the ${stands.cancels}`}`, () => {
        const gates = actionGates({ view: nameView('a', stands.info, 'available'), viewers: [OWNER], head: HEAD + 1 })
        expect(gates.cancel.enabled).toBe(stands.cancels !== null)
        expect(cancellable(stands.info)).toBe(stands.cancels)
      })
    }

    it('with nothing pending, all three open and the cancel tile has nothing to cancel', () => {
      const gates = actionGates({ view: nameView('a', registered(), 'available'), viewers: [OWNER], head: HEAD })
      for (const tile of openers) expect(gates[tile].enabled, tile).toBe(true)
      expect(gates.cancel.reason).toBe('nothing-to-cancel')
      expect(cancellable(registered())).toBeNull()
    })
  })

  it('no wallet identity closes the owner actions with no-viewer, not not-owner', () => {
    const gates = actionGates({ view: nameView('a', registered(), 'available'), viewers: [], head: 0 })
    expect(gates.setTarget.reason).toBe('no-viewer')
  })

  it('identity is a set: any address in it owning the record opens the owner actions', () => {
    const gates = actionGates({ view: nameView('a', registered(), 'available'), viewers: [OTHER, OWNER], head: 0 })
    expect(gates.setTarget.enabled).toBe(true)
    expect(gates.transfer.enabled).toBe(true)
  })
})

describe('signerFor — every action knows which address signs', () => {
  it('owner actions sign with the owning address, wherever it sits in the set', async () => {
    const { signerFor } = await import('./states')
    const view = nameView('a', registered(), 'available')
    expect(signerFor('setTarget', view, [OTHER, OWNER])).toBe(OWNER)
    expect(signerFor('setTarget', view, [OTHER])).toBeNull()
  })

  it('anyone-actions sign with the primary address', async () => {
    const { signerFor } = await import('./states')
    expect(signerFor('register', nameView('a', null, 'available'), [OTHER, OWNER])).toBe(OTHER)
    expect(signerFor('renew', nameView('a', registered(), 'available'), [])).toBeNull()
  })
})

describe('clocks', () => {
  it('the renewal reminder fires from GRACE_PERIOD × 2 before expiry (§10.4)', () => {
    const expiry = 10_000_000
    expect(renewalUrgency(expiry, expiry - 2 * CONSTANTS.GRACE_PERIOD - 1)).toBe('none')
    expect(renewalUrgency(expiry, expiry - 2 * CONSTANTS.GRACE_PERIOD)).toBe('due')
    expect(renewalUrgency(expiry, expiry)).toBe('grace')
  })

  it('an auction end carries the landing margin on top of the typed duration, and outlives the term from expiry itself', () => {
    const { AUCTION_LANDING_MARGIN, auctionEndHeight, auctionOutlivesTerm } = states
    expect(auctionEndHeight(1_000_000, CONSTANTS.AUCTION_MIN_DURATION)).toBe(1_000_000 + AUCTION_LANDING_MARGIN + CONSTANTS.AUCTION_MIN_DURATION)
    // Half-open §7.3: the name is in GRACE *at* expiry, so an end there is already past the last resolving block.
    expect(auctionOutlivesTerm(2_000_000, 2_000_000)).toBe(true)
    expect(auctionOutlivesTerm(1_999_999, 2_000_000)).toBe(false)
  })

  it('registrationFee reads the band off /params.fees by length — a term or a lifetime, never a multiplication', () => {
    const bands: readonly (readonly [number, bigint])[] = [[2, 200n], [3, 100n], [4, 50n], [5, 25n], [6, 10n], [11, 5n], [24, 1n]]
    const fees = bands.map(([upTo, times]) => ({ upTo, times, yearly: 40_000_000n * times, lifetime: 400_000_000n * times }))
    const params = {
      prices: { feeBase: 40_000_000n, commissionBp: 250n },
      fees,
      minPrice: 40_000_000n,
      listingFee: 0n,
      pendingGovernance: null,
      height: 1,
    }
    expect(feeRowFor('short', fees).upTo).toBe(5)
    expect(registrationFee('short', params)).toBe(1_000_000_000n)
    expect(registrationFee('sixsix', params)).toBe(400_000_000n)
    expect(registrationFee('example', params)).toBe(200_000_000n)
    expect(registrationFee('averylongername', params)).toBe(40_000_000n)
    expect(registrationFee('averylongername', params, true)).toBe(400_000_000n)
    // A released short name renews at its own band (2026-09-11).
    expect(registrationFee('ab', params)).toBe(8_000_000_000n)
    expect(() => feeRowFor('x'.repeat(25), fees)).toThrow(/no fee band/)
  })
})

describe('sameAddress', () => {
  it('compares canonically, not textually', () => {
    expect(sameAddress(OWNER, OWNER.toLowerCase())).toBe(true)
    expect(sameAddress(OWNER, OTHER)).toBe(false)
    expect(sameAddress('not an address', OWNER)).toBe(false)
  })
})

// ── The identity row (docs/app-ux.md §1) ────────────────────────────────────

describe('identityRow', () => {
  const wallet = (identity: Identity, connect: unknown | null, disconnect: unknown | null) => ({
    identity,
    connect,
    disconnect,
  })
  const A = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000'
  const B = 'NQ88 0000 0000 0000 0000 0000 0000 0000 0001'

  it('is `checking` while detectWallet is still deciding — never nothing', () => {
    // A blank row and a broken control look identical on a phone. This state
    // exists so the row always draws something.
    expect(identityRow(null)).toEqual({ kind: 'checking' })
  })

  it('offers connect when the host is Pay but has given no accounts', () => {
    // The declined-prompt case. Before 2026-08-22 this fell through to the Hub
    // and offered a desktop web-wallet connector inside Pay's own WebView.
    expect(identityRow(wallet({ kind: 'pay', addresses: [] }, () => {}, () => {}))).toEqual({
      kind: 'connect',
      host: 'pay',
    })
  })

  it('offers connect on the Hub with an empty set', () => {
    expect(identityRow(wallet({ kind: 'hub', addresses: [] }, () => {}, () => {}))).toEqual({
      kind: 'connect',
      host: 'hub',
    })
  })

  it('shows a Pay session its address and a disconnect', () => {
    // The bug that started this: a connected Pay user had no way back out,
    // because the adapter shipped with both handles null.
    expect(identityRow(wallet({ kind: 'pay', addresses: [A, B] }, () => {}, () => {}))).toEqual({
      kind: 'connected',
      host: 'pay',
      primary: A,
      more: 1,
      // Pay's set is the host's, whole — asking again cannot add to it.
      canAdd: false,
      canDisconnect: true,
    })
  })

  it('lets the Hub grow its set one address at a time', () => {
    expect(identityRow(wallet({ kind: 'hub', addresses: [A] }, () => {}, () => {}))).toEqual({
      kind: 'connected',
      host: 'hub',
      primary: A,
      more: 0,
      canAdd: true,
      canDisconnect: true,
    })
  })

  it('never offers an action the wallet does not have', () => {
    const row = identityRow(wallet({ kind: 'hub', addresses: [A] }, null, null))
    expect(row).toMatchObject({ kind: 'connected', canAdd: false, canDisconnect: false })
  })
})

/**
 * The regression this was written for: Pay's card said "Connect a wallet to act
 * on names" and offered nothing to press, because every screen asked
 * `wallet === null` and the Hub adapter answers with a real wallet holding no
 * address (Kike, 2026-09-14, on the deployed app).
 */
describe('connectInstead', () => {
  const wallet = (addresses: readonly string[]) => ({
    identity: { kind: 'hub' as const, addresses },
    connect: () => {},
    disconnect: () => {},
  })

  it('is true for the wallet a browser has before anybody connects', () => {
    expect(connectInstead(wallet([]), true)).toBe(true)
  })

  it('is true while detection is still in flight, so the row says so', () => {
    // `IdentityBar` draws this one as "Checking wallet…" — a state, not a gap.
    expect(connectInstead(null, false)).toBe(true)
  })

  it('is false with an address, whatever the action gate then says', () => {
    expect(connectInstead(wallet([OWNER]), true)).toBe(false)
  })

  it('is false with no connect handler: an empty row is the dead end again', () => {
    expect(connectInstead(wallet([]), false)).toBe(false)
  })
})

describe('the cancellable thing (§6 `K`)', () => {
  const opened = 1_000_000
  const offer = {
    name: 'example',
    seller: OWNER,
    price: 100_000n,
    openedHeight: opened,
    expiryHeight: opened + CONSTANTS.OFFER_MAX_LIFETIME,
  }
  const transfer = { newOwner: OTHER, effectiveHeight: 1_040_000 }

  it('is nothing when nothing is pending, and never an auction', () => {
    expect(cancellable(registered())).toBeNull()
    const underAuction = registered({
      pending: {
        transfer: null,
        offer: null,
        auction: { name: 'example', seller: OWNER, startingPrice: 1n, endHeight: 1_100_000, bidder: null, bid: 0n, minimumBid: 1n },
      },
    })
    // The one thing a `K` can never clear — and nothing else can be pending beside it.
    expect(cancellable(underAuction)).toBeNull()
  })

  it('is the transfer or the sale, whatever the height', () => {
    expect(cancellable(registered({ pending: { transfer, offer: null, auction: null } }))).toBe('transfer')
    expect(cancellable(registered({ pending: { transfer: null, offer, auction: null } }))).toBe('sale')
  })

  it('puts the tile beside what it acts on: ownership for a transfer, marketplace otherwise', () => {
    expect(cancelTileGroup('transfer')).toBe('ownership')
    expect(cancelTileGroup('sale')).toBe('market')
    // Auction open: disabled, and it belongs beside the auction it is about.
    expect(cancelTileGroup(null)).toBe('market')
  })
})

describe('shortfallFor', () => {
  const FEE = 20_000_000n // 200 NIM, the lifetime band a friend tried to pay from an empty wallet

  it('blocks the send when no account can cover the value, and names both numbers', () => {
    expect(shortfallFor(FEE, [0n])).toEqual({ owed: FEE, held: 0n })
    expect(shortfallFor(FEE, [1n, 19_999_999n])).toEqual({ owed: FEE, held: 19_999_999n })
  })

  it('lets it through the moment one account can pay — exactly the value is enough', () => {
    expect(shortfallFor(FEE, [FEE])).toBeNull()
    expect(shortfallFor(FEE, [0n, FEE + 1n])).toBeNull()
  })

  /**
   * A transaction spends one account. Summing the set would clear a wallet
   * where no single address can pay, and the send would be dropped by the
   * network exactly as before.
   */
  it('takes the maximum of the set, never its sum', () => {
    expect(shortfallFor(FEE, [12_000_000n, 12_000_000n])).toEqual({ owed: FEE, held: 12_000_000n })
  })

  /** A broken balance check is never a negative result — the confirm loop's rule. */
  it('refuses nothing on an incomplete reading', () => {
    expect(shortfallFor(FEE, [null])).toBeNull()
    expect(shortfallFor(FEE, [0n, null])).toBeNull()
    expect(shortfallFor(FEE, [])).toBeNull()
  })

  it('has no opinion before the action is prepared', () => {
    expect(shortfallFor(null, [0n])).toBeNull()
  })
})
