import { describe, expect, it } from 'vitest'
import { CONSTANTS, LUNA_PER_NIM, parse, termFor } from '@nimiqnames/core'
import { ActionInputError, parseAuctionDuration, parseNimAmount, prepareAction, type ActionInputs } from './actions'
import type { ApiParams, NameInfo } from './api'
import { blocksApprox, formatApproxDate, lunaToNim } from './format'
import { PRICE_UNCHANGED, offerRepricesLine, termChoiceLabel, transferMovesLine, transferReplacesLine } from './wording'

const OWNER = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000'
const OTHER = 'NQ34 248H 248H 248H 248H 248H 248H 248H 248H'

const BANDS: readonly (readonly [number, bigint])[] = [[2, 200n], [3, 100n], [4, 50n], [5, 25n], [6, 10n], [11, 5n], [24, 1n]]
const FEES = BANDS.map(([upTo, times]) => ({ upTo, times, yearly: 40_000_000n * times, lifetime: 400_000_000n * times }))

const params: ApiParams = {
  prices: { feeBase: 40_000_000n, commissionBp: 250n },
  fees: FEES,
  minPrice: 40_000_000n,
  listingFee: 0n,
  pendingGovernance: null,
  height: 1_000_000,
}

const registered = (over?: Partial<NameInfo['pending']>): NameInfo => ({
  name: 'example',
  reserved: false,
  unreserved: false,
  record: { name: 'example', owner: OWNER, target: OWNER, evm: '', expiry: 2_000_000, status: 'REGISTERED', host: '' },
  pending: { transfer: null, offer: null, auction: null, ...over },
  height: 1_000_000,
})

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0)
const dateAt = (blocksFromNow: number): string => formatApproxDate(new Date(NOW + blocksFromNow * 1000))

const prepare = (inputs: ActionInputs, info: NameInfo | null = registered(), signer = OWNER) =>
  prepareAction({ inputs, name: 'example', info, signer, viewers: [signer], params, apiBase: 'http://api', nowMs: NOW })

describe('prepareAction builds through core and prices exactly (§10.5)', () => {
  it('register pays the standard band exactly for a 7-char name', () => {
    const prepared = prepare({ action: 'register' }, null)
    expect(prepared.request.value).toBe(200_000_000n)
    const parsed = parse(prepared.request.dataHex)
    expect(parsed.ok && parsed.message.type === 'G').toBe(true)
    expect(prepared.request.recipient).toBe(CONSTANTS.TREASURY_ADDRESS)
  })

  it('a registration carries the share link’s ref and reviews who benefits (§10.7)', () => {
    const prepared = prepare({ action: 'register', ref: 'ricomav' }, null)
    const parsed = parse(prepared.request.dataHex)
    expect(parsed.ok && parsed.message.type === 'G' && parsed.message.ref).toBe('ricomav')
    expect(prepared.request.value).toBe(200_000_000n) // the price is unchanged
    expect(prepared.review.some((line) => line.startsWith('Referred by ricomav.') && line.includes(PRICE_UNCHANGED))).toBe(true)
    // The buyer's screen never says what the referrer earns (wording.ts).
    expect(prepared.review.some((line) => /owner earns/i.test(line))).toBe(false)
  })

  // The review reads the rate at the chain head, like the expiry line beside
  // it. It used to fall back to height 0 when `/name` had not answered, which
  // quoted the launch row — 10%, no rebate — on a screen registering at the
  // split's rates. Rico hit it on the first manual registration (2026-09-12).
  it('prices the referral at the head even when the name’s record has not arrived', () => {
    const prepared = prepareAction({
      inputs: { action: 'register', ref: 'ricomav' },
      name: 'example',
      info: null,
      signer: OWNER,
      viewers: [OWNER],
      params: { ...params, height: 61_412_000 },
      apiBase: 'http://api',
      nowMs: NOW,
    })
    const line = prepared.review.find((l) => l.startsWith('Referred by ricomav.'))
    expect(line).toBeDefined()
    expect(line).toContain('5%')
    expect(line).toMatch(/comes back to you/)
  })

  it('a ref that is not a name is dropped, not refused — the field is inert (§6 G)', () => {
    const prepared = prepare({ action: 'register', ref: 'Not A Name' }, null)
    const parsed = parse(prepared.request.dataHex)
    expect(parsed.ok && parsed.message.type === 'G' && parsed.message.ref).toBeNull()
    expect(prepared.review.some((line) => line.includes('Referred by'))).toBe(false)
  })

  it('the registration review spells the term as the choice above it does, from TERM_LENGTH', () => {
    const prepared = prepare({ action: 'register' }, null)
    // The tab said "1 year" and the review under it said "~365 d" (screenshot,
    // 2026-09-14). One term, one spelling, and both derived.
    expect(prepared.review[0]).toBe(`Pays 2,000 NIM to the registry for ${termChoiceLabel()}.`)
    expect(termChoiceLabel()).toBe(termChoiceLabel(CONSTANTS.TERM_LENGTH))
  })

  it('a lifetime registration pays ten yearly fees, carries L, and reviews the date it reaches (§10.4)', () => {
    const prepared = prepare({ action: 'register', lifetime: true }, null)
    expect(prepared.request.value).toBe(2_000_000_000n)
    const parsed = parse(prepared.request.dataHex)
    expect(parsed.ok && parsed.message.type === 'G' && parsed.message.lifetime).toBe(true)
    // No record to measure from: the head is the one `/params` was served at.
    expect(prepared.review[0]).toBe(`Pays 20,000 NIM to the registry. Yours until ${dateAt(termFor(true))}.`)
    expect(prepared.review[0]).not.toMatch(/lifetime/i)
  })

  it('a renewal reviews the new expiry as a date, from the current expiry — a lifetime a hundred terms out', () => {
    const yearly = prepare({ action: 'renew' })
    expect(yearly.request.value).toBe(200_000_000n)
    expect(yearly.review).toContain(`New expiry ${dateAt(2_000_000 - 1_000_000 + termFor(false))}.`)
    const lifetime = prepare({ action: 'renew', lifetime: true })
    expect(lifetime.request.value).toBe(2_000_000_000n)
    const parsed = parse(lifetime.request.dataHex)
    expect(parsed.ok && parsed.message.type === 'N' && parsed.message.lifetime).toBe(true)
    expect(lifetime.review).toContain(`New expiry ${dateAt(2_000_000 - 1_000_000 + termFor(true))}.`)
  })

  it('a renewal by someone other than the owner reviews as a gift, and the owner\'s does not', () => {
    const gift = prepare({ action: 'renew' }, registered(), OTHER)
    expect(gift.request.recipient).toBe(CONSTANTS.TREASURY_ADDRESS)
    expect(gift.review.some((line) => line.includes('don’t own'))).toBe(true)
    const own = prepare({ action: 'renew' })
    expect(own.review.some((line) => line.includes('don’t own'))).toBe(false)
  })

  it('set target reset routes to the PROTOCOL_ADDRESS sentinel and expects the signer', () => {
    const prepared = prepare({ action: 'setTarget', target: 'reset' })
    expect(prepared.request.recipient).toBe(CONSTANTS.PROTOCOL_ADDRESS)
    expect(prepared.request.value).toBe(CONSTANTS.DUST_VALUE)
  })

  it('set target to an address routes to that address — the wallet sheet shows it (§5.3)', async () => {
    const { sameAddress } = await import('./states')
    const prepared = prepare({ action: 'setTarget', target: OTHER })
    expect(sameAddress(prepared.request.recipient, OTHER)).toBe(true)
  })

  it('refuses a target that is the signer, in words about the name', () => {
    // `S` carries the target as the recipient (§5.3), so this reaches core's
    // "sender and recipient must differ" — a sentence about transactions, on
    // a sheet about a name. Easy to arrive at since the field takes a name:
    // typing a name of your own resolves straight to your own address.
    expect(() => prepare({ action: 'setTarget', target: OWNER })).toThrow(/Point back at my address/)
  })

  it('set EVM address routes to PROTOCOL_ADDRESS at dust, base64url in the payload (§6 E)', () => {
    const prepared = prepare({ action: 'setEvm', evm: '0x1b3f6a09e2c40d55c8a1b2c3d4e5f60718293a4b' })
    expect(prepared.request.recipient).toBe(CONSTANTS.PROTOCOL_ADDRESS)
    expect(prepared.request.value).toBe(CONSTANTS.DUST_VALUE)
    expect(Buffer.from(prepared.request.dataHex, 'hex').toString()).toBe('NNS1Eexample|Gz9qCeLEDVXIobLD1OX2BxgpOks')
  })

  it('set EVM address enforces EIP-55 on mixed-case input — the only checksum the record gets', () => {
    // Correct checksum case for this address flips at least one letter; break one.
    expect(() => prepare({ action: 'setEvm', evm: '0x5Aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed' })).toThrow(
      /checksum/,
    )
  })

  it('clearing the EVM address sends the empty field form', () => {
    const prepared = prepare({ action: 'setEvm', evm: 'clear' })
    expect(Buffer.from(prepared.request.dataHex, 'hex').toString()).toBe('NNS1Eexample|')
  })

  it('transfer to the owning address is refused before any transaction exists', () => {
    expect(() => prepare({ action: 'transfer', newOwner: OWNER })).toThrow(ActionInputError)
  })

  // The delay was typed into the sentence as "~12 h". `XFER_TIMELOCK` is 600
  // blocks in the tempo era both boxes run, so the one number the line existed
  // to carry was wrong on every deployment we have (Rico, 2026-09-15).
  it('the transfer review reads its delay from the constant, never from a typed string', () => {
    const line = prepare({ action: 'transfer', newOwner: OTHER }).review.join(' ')
    expect(line).toBe(transferMovesLine(blocksApprox(CONSTANTS.XFER_TIMELOCK)))
    // One sentence, and not a second copy of the address the field shows.
    expect(line.split('. ')).toHaveLength(1)
    expect(line).not.toContain(OTHER)
  })

  it('an offer parses NIM decimals to exact luna and carries dust value', () => {
    const prepared = prepare({ action: 'offer', priceNim: '450.5' })
    expect(prepared.request.value).toBe(CONSTANTS.DUST_VALUE)
    const parsed = parse(prepared.request.dataHex)
    expect(parsed.ok && parsed.message.type === 'O' && parsed.message.price === 45_050_000n).toBe(true)
  })

  it('buy pays the offer price exactly, to the marketplace', () => {
    const withOffer = registered({
      offer: { name: 'example', seller: OWNER, price: 45_050_000n, openedHeight: 1, expiryHeight: 2_000_000 },
    })
    const prepared = prepare({ action: 'buy' }, withOffer, OTHER)
    expect(prepared.request.value).toBe(45_050_000n)
    expect(prepared.request.recipient).toBe(CONSTANTS.MARKETPLACE_ADDRESS)
  })

  it('buy review presents the seller — the wallet sheet only ever shows the marketplace (§5.3, app-ux §5)', () => {
    const withOffer = registered({
      offer: { name: 'example', seller: OWNER, price: 45_050_000n, openedHeight: 1, expiryHeight: 2_000_000 },
    })
    const prepared = prepare({ action: 'buy' }, withOffer, OTHER)
    expect(prepared.review.some((line) => line.includes(OWNER))).toBe(true)
  })

  it('buying your own name is refused', () => {
    const withOffer = registered({
      offer: { name: 'example', seller: OWNER, price: 45_050_000n, openedHeight: 1, expiryHeight: 2_000_000 },
    })
    expect(() => prepare({ action: 'buy' }, withOffer, OWNER)).toThrow(ActionInputError)
  })

  it('a transfer on a transferring name says what it replaces (§7.3)', () => {
    const pending = registered({ transfer: { newOwner: OTHER, effectiveHeight: 1_040_000 } })
    const prepared = prepare({ action: 'transfer', newOwner: 'NQ19 KSMT HHEJ TYNF J1GK 40NK LHSL C5P7 P24M' }, pending)
    expect(prepared.review[0]).toBe(transferReplacesLine(OTHER, blocksApprox(CONSTANTS.XFER_TIMELOCK)))
  })

  it('a listing on a listed name says it reprices (§7.3)', () => {
    const listed = registered({ offer: { name: 'example', seller: OWNER, price: 45_050_000n, openedHeight: 1, expiryHeight: 2_000_000 } })
    const prepared = prepare({ action: 'offer', priceNim: '500' }, listed)
    expect(prepared.review[0]).toBe(offerRepricesLine('example', lunaToNim(45_050_000n), '500'))
  })

  it('cancel review names the one thing the K clears: a transfer', () => {
    const pending = registered({ transfer: { newOwner: OTHER, effectiveHeight: 1_040_000 } })
    const prepared = prepare({ action: 'cancel' }, pending)
    expect(prepared.review).toHaveLength(1)
    expect(prepared.review[0]).toMatch(/^Cancels the transfer/)
  })

  it('cancel review names the one thing the K clears: a sale, at any height (r30 fold)', () => {
    // No irrevocable window any more: a `K` sent the block after listing withdraws it.
    const fresh = registered({ offer: { name: 'example', seller: OWNER, price: 45_050_000n, openedHeight: 999_999, expiryHeight: 2_000_000 } })
    const prepared = prepare({ action: 'cancel' }, fresh)
    expect(prepared.review).toHaveLength(1)
    // The verb, not the noun: the app calls a listing a sale.
    expect(prepared.review[0]).toMatch(/^Takes it off sale/)
  })

  // Rico, 2026-09-15: *"show on the Cancel Transfer section how much time is
  // remaining to cancel it since right now you can just guess it"*.
  it('cancel says how long is left to use it', () => {
    const pending = registered({ transfer: { newOwner: OTHER, effectiveHeight: 1_040_000 } })
    const prepared = prepare({ action: 'cancel' }, pending)
    expect(prepared.review[0]).toContain(`(${blocksApprox(40_000)} left)`)
  })

  it('cancel confirms on the thing it cleared', async () => {
    const offer = { name: 'example', seller: OWNER, price: 45_050_000n, openedHeight: 995_000, expiryHeight: 2_000_000 }
    const listed = registered({ offer })
    const prepared = prepare({ action: 'cancel' }, listed)
    const withOffer = { ...listed, pending: { transfer: null, auction: null, offer: { ...offer, price: offer.price.toString() } } }
    const cleared = { ...listed, pending: { transfer: null, auction: null, offer: null } }
    const original = globalThis.fetch
    const serve = (body: unknown) => {
      globalThis.fetch = (() =>
        Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }))) as typeof fetch
    }
    try {
      serve(withOffer)
      expect(await prepared.confirm()).toBe(false)
      serve(cleared)
      expect(await prepared.confirm()).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })

  describe('auction and bid (§6 `A`, r28)', () => {
    const auction = { name: 'example', seller: OWNER, startingPrice: 100_000_000n, endHeight: 1_100_000, bidder: null, bid: 0n, minimumBid: 100_000_000n }
    const underAuction = registered({ auction })

    it('an A carries dust to PROTOCOL_ADDRESS, the starting price exactly, and an end past the typed duration by the landing margin', async () => {
      const { AUCTION_LANDING_MARGIN } = await import('./states')
      const prepared = prepare({ action: 'auction', startingPriceNim: '1000', durationDays: '2' })
      expect(prepared.request.recipient).toBe(CONSTANTS.PROTOCOL_ADDRESS)
      expect(prepared.request.value).toBe(CONSTANTS.DUST_VALUE)
      const parsed = parse(prepared.request.dataHex)
      expect(parsed.ok && parsed.message.type === 'A' && parsed.message.startingPrice === 1000n * LUNA_PER_NIM).toBe(true)
      expect(parsed.ok && parsed.message.type === 'A' && parsed.message.endHeight).toBe(1_000_000 + AUCTION_LANDING_MARGIN + 2 * 86_400)
    })

    it('a starting price below MIN_PRICE never reaches the chain — core refuses to build it', () => {
      expect(() => prepare({ action: 'auction', startingPriceNim: '1', durationDays: '2' })).toThrow(/MIN_PRICE|starting price/i)
    })

    it('a duration under AUCTION_MIN_DURATION is refused before any transaction exists', () => {
      expect(() => prepare({ action: 'auction', startingPriceNim: '1000', durationDays: '0.5' })).toThrow(ActionInputError)
      expect(parseAuctionDuration('1')).toBe(CONSTANTS.AUCTION_MIN_DURATION)
      expect(parseAuctionDuration('1,5')).toBe(129_600)
      for (const bad of ['', 'abc', '-1', '1.234', '0']) expect(() => parseAuctionDuration(bad), bad).toThrow(ActionInputError)
    })

    it('a duration over AUCTION_MAX_DURATION is refused too, and the cap itself is a legal auction (r31 fold)', () => {
      expect(() => prepare({ action: 'auction', startingPriceNim: '1000', durationDays: '30' })).toThrow(/at most/)
      expect(parseAuctionDuration('7')).toBe(CONSTANTS.AUCTION_MAX_DURATION)
      expect(() => parseAuctionDuration('7.01')).toThrow(ActionInputError)
    })

    it('the review says what opening voids, and refuses an end at or past the term (AUCTION_BEYOND_TERM)', () => {
      const withBoth = registered({
        transfer: { newOwner: OTHER, effectiveHeight: 1_040_000 },
        offer: { name: 'example', seller: OWNER, price: 45_050_000n, openedHeight: 1, expiryHeight: 2_000_000 },
      })
      const prepared = prepare({ action: 'auction', startingPriceNim: '1000', durationDays: '2' }, withBoth)
      expect(prepared.review.some((line) => line.includes('transfer'))).toBe(true)
      expect(prepared.review.some((line) => line.includes('sale'))).toBe(true)
      expect(prepared.review.some((line) => line.includes('Renew first'))).toBe(false)
      // A name three days from expiry: a five-day window is inside the cap
      // and lands past the term — the message would forfeit, so the sheet refuses.
      const nearExpiry = { ...registered(), record: { ...registered().record!, expiry: 1_000_000 + 3 * 86_400 } }
      expect(() => prepare({ action: 'auction', startingPriceNim: '1000', durationDays: '5' }, nearExpiry)).toThrow(/Renew first/)
    })

    it('a bid is a B to the marketplace whose value is the bid — at least the minimum, never less', () => {
      const prepared = prepare({ action: 'bid', bidNim: '1000' }, underAuction, OTHER)
      expect(prepared.request.recipient).toBe(CONSTANTS.MARKETPLACE_ADDRESS)
      expect(prepared.request.value).toBe(1000n * LUNA_PER_NIM)
      const parsed = parse(prepared.request.dataHex)
      expect(parsed.ok && parsed.message.type === 'B').toBe(true)
      expect(() => prepare({ action: 'bid', bidNim: '999.99999' }, underAuction, OTHER)).toThrow(/at least 1,000 NIM/)
    })

    // The seller is on the review: the wallet's sheet shows the marketplace
    // address and nothing else, so this is the only place the bidder sees who
    // they are bidding against. The refund reading of `WRONG_PRICE` is a rule
    // rather than a change, so it moved into the bubble (2026-09-15).
    it('the bid review names the seller, and the hint carries the refund reading of WRONG_PRICE', () => {
      const prepared = prepare({ action: 'bid', bidNim: '1000' }, underAuction, OTHER)
      expect(prepared.review.some((line) => line.includes(OWNER))).toBe(true)
      expect(prepared.review.join(' ')).not.toContain('refunded')
      expect(prepared.reviewHint).toContain('refunded')
    })

    it('bidding on your own auction is refused, and there is nothing to bid on without one', () => {
      expect(() => prepare({ action: 'bid', bidNim: '1000' }, underAuction, OWNER)).toThrow(ActionInputError)
      expect(() => prepare({ action: 'bid', bidNim: '1000' }, registered(), OTHER)).toThrow(ActionInputError)
    })
  })

  it('a malformed price never reaches an encoder', () => {
    expect(() => prepare({ action: 'offer', priceNim: '1,234567' })).toThrow(ActionInputError)
    expect(() => prepare({ action: 'offer', priceNim: '' })).toThrow(ActionInputError)
  })
})

/**
 * One parser for NIM decimals, shared by the `O` price and the Pay amount —
 * two would be two chances to disagree about how much money a user meant.
 */
describe('parseNimAmount', () => {
  it('takes integers and up to five decimals, exactly, with . or , between', () => {
    expect(parseNimAmount('450')).toBe(450n * LUNA_PER_NIM)
    expect(parseNimAmount('1.5')).toBe(LUNA_PER_NIM + LUNA_PER_NIM / 2n)
    expect(parseNimAmount('1,5')).toBe(LUNA_PER_NIM + LUNA_PER_NIM / 2n)
    expect(parseNimAmount('0.00001')).toBe(1n)
    expect(parseNimAmount(' 2 ')).toBe(2n * LUNA_PER_NIM)
  })

  it('refuses what is not an amount, and says which field', () => {
    // Six decimals is below luna: silently rounding it would move money the
    // user did not mean to move. One separator per amount: grouped thousands
    // like 1.000,5 are ambiguous between locales, so they never parse.
    for (const bad of ['1.234567', '1,234567', 'abc', '-1', '', '1.', '.5', ',5', '1e3', '1.000,5', '1,000.5']) {
      expect(() => parseNimAmount(bad), bad).toThrow(ActionInputError)
    }
    expect(() => parseNimAmount('abc', 'Amount')).toThrow(/^Amount must be/)
  })

  it('refuses an amount grouped the way the app now prints one', () => {
    // `format.ts` groups in threes, so `12,345` is a string the reader can see
    // and retype — and the rule above reads `,` as a decimal point, which
    // would take it as 12.345 NIM. A thousandfold underbid that passes every
    // check after it is the one outcome this field may not have, so the shape
    // is refused by name rather than guessed at.
    for (const bad of ['1,000', '12,345', '123,456,789', '1.234.567', '18,765.84304']) {
      expect(() => parseNimAmount(bad), bad).toThrow(/without thousands separators/)
    }
    expect(() => parseNimAmount('12,345', 'Bid')).toThrow(/^Bid is typed without/)
    // The price of that: `1,500` meaning one and a half is an error now. Both
    // unambiguous spellings of it still parse.
    expect(parseNimAmount('1.5')).toBe(LUNA_PER_NIM + LUNA_PER_NIM / 2n)
    expect(parseNimAmount('1,5')).toBe(LUNA_PER_NIM + LUNA_PER_NIM / 2n)
    // A period with three decimals is not grouping in this notation, and has
    // always meant what it says.
    expect(parseNimAmount('12.345')).toBe(12n * LUNA_PER_NIM + 34_500n)
  })
})

describe('an acquisition confirms against the whole identity set, not the assumed signer', () => {
  // Nimiq Pay signs with whichever of its addresses holds the balance, and it
  // is never listAccounts()[0] — which is exactly what `signerFor` answers for
  // `register`, `renew` and `buy`. Confirming against that address compared the
  // new owner with one that had not signed: false on every poll, so a real
  // mainnet registration could not reach `confirmed` at any timeout, while the
  // name sat registered and visible in "My names" (2026-08-21).
  const LOCAL = 'NQ88 XL24 NHPU MYVX 67AC TXLX NQX1 R471 EGM9'
  const REMOTE = 'NQ89 R3HN 70XQ 2E5A L4YS CV2Q UL5J 84TX 8L8H'

  const confirmAgainst = async (owner: string, viewers: readonly string[]) => {
    const info: NameInfo = {
      ...registered(),
      record: { ...registered().record!, owner, target: owner },
    }
    const original = globalThis.fetch
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify(info), { headers: { 'content-type': 'application/json' } }))) as typeof fetch
    try {
      return await prepareAction({
        inputs: { action: 'register' },
        name: 'example',
        info: null,
        signer: LOCAL,
        viewers,
        params,
        apiBase: 'http://api',
      }).confirm()
    } finally {
      globalThis.fetch = original
    }
  }

  it('confirms when a different address in the set turns out to be the owner', async () => {
    expect(await confirmAgainst(REMOTE, [LOCAL, REMOTE])).toBe(true)
  })

  it('still refuses an owner that is nobody in the set', async () => {
    expect(await confirmAgainst('NQ42 5QRF L5AV J6K3 BQHQ FAE8 XXHR TS8Y 9YRA', [LOCAL, REMOTE])).toBe(false)
  })
})

describe('delegate: the review names the mechanism, and a no-op `D` is refused', () => {
  const withHost = (host: string): NameInfo => {
    const info = registered()
    return { ...info, record: { ...info.record!, host } }
  }

  it('setting a host says the host answers, and keeps the trust caveat in the hint', () => {
    const prepared = prepare({ action: 'delegate', host: 'nns.example.com' }, withHost(''))
    expect(prepared.review).toEqual(['nns.example.com will answer for everything under example.'])
    // Who the addresses come from is the caveat; the delegation itself is on
    // chain, and the hint says that first (Rico, 2026-09-15: the old line
    // "sounds scary when it shouldn't").
    expect(prepared.reviewHint).toMatch(/come from nns\.example\.com/)
    expect(prepared.reviewHint).toMatch(/on chain/)
  })

  // The old line was "Subdomains under example stop resolving", which reads as
  // NNS withdrawing a resolution it was performing. §8.6 gives a label no
  // record, so the host is the only thing that ever answered.
  it('clearing a host never implies an on-chain fallback', () => {
    const prepared = prepare({ action: 'delegate', host: 'clear' }, withHost('nns.example.com'))
    expect(prepared.review).toEqual(['No host will answer for subdomains under example.'])
    expect(prepared.reviewHint).toMatch(/resolve only through the host/)
    expect(prepared.review.join(' ')).not.toMatch(/stop resolving/)
  })

  // Both reviews are one sentence, because the sheet is a form and the bubble
  // beside it is where the second sentence went (Rico, 2026-09-15).
  it('says it in one sentence either way', () => {
    for (const host of ['nns.example.com', 'clear']) {
      const prepared = prepare({ action: 'delegate', host }, withHost(host === 'clear' ? 'nns.example.com' : ''))
      expect(prepared.review).toHaveLength(1)
      expect(prepared.review[0]!.split('. ')).toHaveLength(1)
    }
  })

  it('refuses a clear on a name that has none — the `D` would change nothing', () => {
    expect(() => prepare({ action: 'delegate', host: 'clear' }, withHost(''))).toThrow(ActionInputError)
  })

  // The sheet gates this too (the field is what `inputsTouched` watches), but
  // an empty field is not an instruction and must never reach the builder as
  // one: clearing is the checkbox, which sends `'clear'`.
  it('refuses an empty field rather than reading it as a clear', () => {
    expect(() => prepare({ action: 'delegate', host: '   ' }, withHost('nns.example.com'))).toThrow(ActionInputError)
  })

  it('still clears when the record could not be read, rather than refusing a real clear', () => {
    expect(() => prepare({ action: 'delegate', host: 'clear' }, null)).not.toThrow()
  })
})

describe('the seller is told what they receive, at the rate /params served', () => {
  // The old line — "the marketplace takes its commission from the sale, not
  // from listing" — contrasted the sale against a charge that does not exist:
  // LISTING_FEE is 0, so nothing is paid at listing at all.
  it('the offer review names the amount and no longer mentions listing', () => {
    const review = prepare({ action: 'offer', priceNim: '1000' }).review.join(' ')
    expect(review).toContain('You get 975 NIM if it sells')
    expect(review).toContain('2.5%')
    expect(review).not.toMatch(/not from listing/)
  })

  // The rate is governable (§10.6), so a restated CONSTANTS.COMMISSION_RATE
  // would put a number on screen the settlement will not honour. Prove the
  // line follows the served value.
  it('follows a governed rate rather than the compiled-in constant', () => {
    const governed: ApiParams = { ...params, prices: { ...params.prices, commissionBp: 100n } }
    const review = prepareAction({
      inputs: { action: 'offer', priceNim: '1000' },
      name: 'example',
      info: registered(),
      signer: OWNER,
      viewers: [OWNER],
      params: governed,
      apiBase: 'http://api',
      nowMs: NOW,
    }).review.join(' ')
    expect(review).toContain('You get 990 NIM if it sells')
    expect(review).toContain('1%')
  })

  it('an auction quotes a minimum, since the starting price is only a floor', () => {
    const review = prepare({ action: 'auction', startingPriceNim: '1000', durationDays: '3' }).review.join(' ')
    expect(review).toContain('at least 975 NIM')
  })
})
