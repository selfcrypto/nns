import { describe, expect, it } from 'vitest'
import { CONSTANTS, LUNA_PER_NIM, parse } from '@nns/core'
import { ActionInputError, parseNimAmount, prepareAction, type ActionInputs } from './actions'
import type { ApiParams, NameInfo } from './api'

const OWNER = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000'
const OTHER = 'NQ34 248H 248H 248H 248H 248H 248H 248H 248H'

const params: ApiParams = {
  prices: { feeStandard: 200_000_000n, feeLong: 40_000_000n, commissionBp: 250n },
  minPrice: 40_000_000n,
  listingFee: 0n,
  pendingGovernance: null,
  height: 1_000_000,
}

const registered = (over?: Partial<NameInfo['pending']>): NameInfo => ({
  name: 'example',
  reserved: false,
  unreserved: false,
  record: { name: 'example', owner: OWNER, target: OWNER, expiry: 2_000_000, status: 'REGISTERED', host: '' },
  pending: { transfer: null, offer: null, ...over },
  height: 1_000_000,
})

const prepare = (inputs: ActionInputs, info: NameInfo | null = registered(), signer = OWNER) =>
  prepareAction({ inputs, name: 'example', info, signer, params, apiBase: 'http://api' })

describe('prepareAction builds through core and prices exactly (§10.5)', () => {
  it('register pays the standard band exactly for a 7-char name', () => {
    const prepared = prepare({ action: 'register' }, null)
    expect(prepared.request.value).toBe(200_000_000n)
    const parsed = parse(prepared.request.dataHex)
    expect(parsed.ok && parsed.message.type === 'G').toBe(true)
    expect(prepared.request.recipient).toBe(CONSTANTS.TREASURY_ADDRESS)
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
    expect(prepared.review.some((line) => line.includes('offer'))).toBe(true)
  })

  it('a malformed price never reaches an encoder', () => {
    expect(() => prepare({ action: 'offer', priceNim: '1,5' })).toThrow(ActionInputError)
    expect(() => prepare({ action: 'offer', priceNim: '' })).toThrow(ActionInputError)
  })
})

/**
 * One parser for NIM decimals, shared by the `O` price and the Pay amount —
 * two would be two chances to disagree about how much money a user meant.
 */
describe('parseNimAmount', () => {
  it('takes integers and up to five decimals, exactly', () => {
    expect(parseNimAmount('450')).toBe(450n * LUNA_PER_NIM)
    expect(parseNimAmount('1.5')).toBe(LUNA_PER_NIM + LUNA_PER_NIM / 2n)
    expect(parseNimAmount('0.00001')).toBe(1n)
    expect(parseNimAmount(' 2 ')).toBe(2n * LUNA_PER_NIM)
  })

  it('refuses what is not an amount, and says which field', () => {
    // Six decimals is below luna: silently rounding it would move money the
    // user did not mean to move.
    for (const bad of ['1.234567', 'abc', '-1', '', '1,5', '1.', '.5', '1e3']) {
      expect(() => parseNimAmount(bad), bad).toThrow(ActionInputError)
    }
    expect(() => parseNimAmount('abc', 'Amount')).toThrow(/^Amount must be/)
  })
})
