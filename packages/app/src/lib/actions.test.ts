import { describe, expect, it } from 'vitest'
import { CONSTANTS, LUNA_PER_NIM, parse, termFor } from '@nimiqnames/core'
import { ActionInputError, parseAuctionDuration, parseNimAmount, prepareAction, type ActionInputs } from './actions'
import type { ApiParams, NameInfo } from './api'
import { formatApproxDate } from './format'

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
    expect(prepared.review.some((line) => line.startsWith('Referred by ricomav.') && line.includes('You pay the same'))).toBe(true)
    // The buyer's screen never says what the referrer earns (wording.ts).
    expect(prepared.review.some((line) => /owner earns/i.test(line))).toBe(false)
  })

  // The review reads the rate at the chain head, like the expiry line beside
  // it. It used to fall back to height 0 when `/name` had not answered, which
  // quoted the launch row — 10%, no rebate — on a screen registering at the
  // split's rates. Kike hit it on the first manual registration (2026-09-12).
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

  it('the registration review states the term from TERM_LENGTH, never a typed year', () => {
    const prepared = prepare({ action: 'register' }, null)
    expect(prepared.review[0]).toMatch(/^Pays 2,?000 NIM to the registry for a ~\d+ d term\.$/)
  })

  it('a lifetime registration pays ten yearly fees, carries L, and reviews the date it reaches (§10.4)', () => {
    const prepared = prepare({ action: 'register', lifetime: true }, null)
    expect(prepared.request.value).toBe(2_000_000_000n)
    const parsed = parse(prepared.request.dataHex)
    expect(parsed.ok && parsed.message.type === 'G' && parsed.message.lifetime).toBe(true)
    // No record to measure from: the head is the one `/params` was served at.
    expect(prepared.review[0]).toBe(`Pays 20000 NIM to the registry — yours until ${dateAt(termFor(true))}.`)
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

  it('cancel review names everything the one K clears', () => {
    const both = registered({
      transfer: { newOwner: OTHER, effectiveHeight: 1_040_000 },
      offer: { name: 'example', seller: OWNER, price: 45_050_000n, openedHeight: 1, expiryHeight: 2_000_000 },
    })
    const prepared = prepare({ action: 'cancel' }, both)
    expect(prepared.review.some((line) => line.includes('transfer'))).toBe(true)
    // The verb, not the noun: the "stays standing" line also says "offer".
    expect(prepared.review.some((line) => line.startsWith('Withdraws'))).toBe(true)
  })

  // The offer's irrevocable window outlives the review: a `K` sent now clears
  // the transfer and leaves the listing (§6 `O`). Promising the withdrawal made
  // the review a lie and the confirm poll unsatisfiable, so a `K` that had done
  // exactly what it could reported back as unconfirmed.
  const freshOffer = { name: 'example', seller: OWNER, price: 45_050_000n, openedHeight: 995_000, expiryHeight: 2_000_000 }

  it('cancel review does not promise a withdrawal the irrevocable window forbids', () => {
    const both = registered({ transfer: { newOwner: OTHER, effectiveHeight: 1_040_000 }, offer: freshOffer })
    const prepared = prepare({ action: 'cancel' }, both)
    expect(prepared.review.some((line) => line.startsWith('Cancels the transfer'))).toBe(true)
    expect(prepared.review.some((line) => line.startsWith('Withdraws'))).toBe(false)
    expect(prepared.review.some((line) => line.includes('listing stays'))).toBe(true)
  })

  it('cancel confirms on the transfer alone when the offer was never in the set', async () => {
    const both = registered({ transfer: { newOwner: OTHER, effectiveHeight: 1_040_000 }, offer: freshOffer })
    const prepared = prepare({ action: 'cancel' }, both)
    // What the API shows after the `K` lands: the transfer gone, the offer
    // standing. Serialised as the API serialises it — luna as a string.
    const after = {
      ...both,
      pending: { transfer: null, auction: null, offer: { ...freshOffer, price: freshOffer.price.toString() } },
    }
    const original = globalThis.fetch
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify(after), { headers: { 'content-type': 'application/json' } }))) as typeof fetch
    try {
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

    it('the review says what opening voids, and refuses an end at or past the term (AUCTION_BEYOND_TERM)', () => {
      const withBoth = registered({
        transfer: { newOwner: OTHER, effectiveHeight: 1_040_000 },
        offer: { name: 'example', seller: OWNER, price: 45_050_000n, openedHeight: 1, expiryHeight: 2_000_000 },
      })
      const prepared = prepare({ action: 'auction', startingPriceNim: '1000', durationDays: '2' }, withBoth)
      expect(prepared.review.some((line) => line.includes('transfer'))).toBe(true)
      expect(prepared.review.some((line) => line.includes('offer'))).toBe(true)
      expect(prepared.review.some((line) => line.includes('renew first'))).toBe(false)
      // Expiry at 2_000_000; 12 days from 1_000_000 lands past it — the message would forfeit, so the sheet refuses.
      expect(() => prepare({ action: 'auction', startingPriceNim: '1000', durationDays: '12' })).toThrow(/renew first/)
    })

    it('a bid is a B to the marketplace whose value is the bid — at least the minimum, never less', () => {
      const prepared = prepare({ action: 'bid', bidNim: '1000' }, underAuction, OTHER)
      expect(prepared.request.recipient).toBe(CONSTANTS.MARKETPLACE_ADDRESS)
      expect(prepared.request.value).toBe(1000n * LUNA_PER_NIM)
      const parsed = parse(prepared.request.dataHex)
      expect(parsed.ok && parsed.message.type === 'B').toBe(true)
      expect(() => prepare({ action: 'bid', bidNim: '999.99999' }, underAuction, OTHER)).toThrow(/at least 1000 NIM/)
    })

    it('the bid review names the seller and the refund reading of WRONG_PRICE', () => {
      const prepared = prepare({ action: 'bid', bidNim: '1000' }, underAuction, OTHER)
      expect(prepared.review.some((line) => line.includes(OWNER))).toBe(true)
      expect(prepared.review.some((line) => line.includes('refunded'))).toBe(true)
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

  it('setting a host says the host answers, and that its word is not proven', () => {
    const review = prepare({ action: 'delegate', host: 'nns.example.com' }, withHost('')).review
    expect(review.join(' ')).toContain('nns.example.com will answer for everything under example')
    expect(review.join(' ')).toMatch(/not proven/)
  })

  // The old line was "Subdomains under example stop resolving", which reads as
  // NNS withdrawing a resolution it was performing. §8.6 gives a label no
  // record, so the host is the only thing that ever answered.
  it('clearing a host never implies an on-chain fallback', () => {
    const review = prepare({ action: 'delegate', host: '' }, withHost('nns.example.com')).review
    expect(review.join(' ')).toContain('No host will answer for subdomains under example')
    expect(review.join(' ')).toMatch(/never on-chain/)
    expect(review.join(' ')).not.toMatch(/stop resolving/)
  })

  it('refuses an empty host on a name that has none — the `D` would change nothing', () => {
    expect(() => prepare({ action: 'delegate', host: '' }, withHost(''))).toThrow(ActionInputError)
  })

  it('still clears when the record could not be read, rather than refusing a real clear', () => {
    expect(() => prepare({ action: 'delegate', host: '' }, null)).not.toThrow()
  })
})
