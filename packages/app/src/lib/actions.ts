/**
 * The docs/app-ux.md §5 flow table as code: for each action, how to build
 * the transaction (always `@nns/core` encoders — never a payload
 * concatenated here), what the review screen must say beyond the generic
 * lines, and which visible effect confirms it. Pure except the confirm
 * closures, which read the API.
 */

import {
  CONSTANTS,
  encodeAuction,
  encodeBuy,
  encodeCancel,
  encodeDelegate,
  encodeOffer,
  encodeRegister,
  encodeRenew,
  encodeSetEvm,
  encodeSetTarget,
  encodeTransfer,
  formatAddress,
  LUNA_PER_NIM,
  parseAddress,
  tryParseAddress,
  tryParseEvmAddress,
  type BuiltTransaction,
} from '@nns/core'
import { getNameInfo, type ApiParams, type NameInfo } from './api'
import { approxDate, blocksApprox, ellipsizeAddress, formatApproxDate, lunaToNim } from './format'
import { auctionOutlivesTermLine, bidRefundLine, giftRenewalLine, offerStaysLine, referredByLine, registerPaysLine, soldByLine } from './wording'
import { isReferralName } from './referral'
import { percentOf, referralRateBp } from './referralRates'
import { auctionEndHeight, auctionOutlivesTerm, cancellableNow, offerCancellableAt, sameAddress, registrationFee } from './states'
import type { AppAction } from './states'
import type { SubmitRequest } from './wallet'

export type ActionInputs =
  | { readonly action: 'register'; readonly ref?: string | null | undefined }
  | { readonly action: 'renew' }
  | { readonly action: 'cancel' }
  | { readonly action: 'buy' }
  | { readonly action: 'setTarget'; readonly target: string | 'reset' }
  | { readonly action: 'setEvm'; readonly evm: string | 'clear' }
  | { readonly action: 'transfer'; readonly newOwner: string }
  | { readonly action: 'delegate'; readonly host: string }
  | { readonly action: 'offer'; readonly priceNim: string }
  | { readonly action: 'auction'; readonly startingPriceNim: string; readonly durationDays: string }
  | { readonly action: 'bid'; readonly bidNim: string }

export interface PreparedAction {
  readonly action: AppAction
  readonly request: SubmitRequest
  /** Lines the review screen adds to the generic ones (docs/app-ux.md §5). */
  readonly review: readonly string[]
  /** True when the effect is visible at the API — the only confirmation there is. */
  readonly confirm: () => Promise<boolean>
}

export class ActionInputError extends Error {
  override readonly name = 'ActionInputError'
}

/**
 * A NIM decimal to `bigint` luna — five decimals, the whole precision there is.
 * Exported because the Pay screen takes an amount too, and two parsers for one
 * notation is how they come to disagree. `,` separates decimals as well as `.`
 * — regional keyboards write 1,5 — and only that: no thousands grouping.
 */
export const parseNimAmount = (text: string, what = 'Price'): bigint => {
  const match = /^([0-9]+)(?:[.,]([0-9]{1,5}))?$/.exec(text.trim())
  if (match === null || match[1] === undefined) throw new ActionInputError(`${what} must be a NIM amount, like 450 or 1.5`)
  return BigInt(match[1]) * LUNA_PER_NIM + BigInt((match[2] ?? '').padEnd(5, '0'))
}

const parseNimPrice = (text: string): bigint => parseNimAmount(text)

/** The block clock's day, ~1 block/s — the same figure `format.ts` renders durations with. */
const BLOCKS_PER_DAY = 86_400

/**
 * An auction duration typed in days, to blocks. Two decimals — a quarter day
 * is the finest anyone plans a sale in — and never below `AUCTION_MIN_DURATION`,
 * which §6 `A` forfeits on. The landing margin is added on top by
 * `auctionEndHeight`, so the minimum typed here is a legal auction.
 */
export const parseAuctionDuration = (text: string): number => {
  const match = /^([0-9]+)(?:[.,]([0-9]{1,2}))?$/.exec(text.trim())
  if (match === null || match[1] === undefined) throw new ActionInputError('Duration must be a number of days, like 3 or 1.5')
  const hundredths = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  const blocks = Math.round((hundredths * BLOCKS_PER_DAY) / 100)
  if (blocks < CONSTANTS.AUCTION_MIN_DURATION) {
    throw new ActionInputError(`An auction runs at least ${blocksApprox(CONSTANTS.AUCTION_MIN_DURATION)}`)
  }
  return blocks
}

const requireAddress = (input: string, what: string): string => {
  const parsed = tryParseAddress(input)
  if (parsed === null) throw new ActionInputError(`${what} is not a Nimiq address`)
  // Spaced form: these strings reach review lines the user reads.
  return formatAddress(parsed)
}

export function prepareAction(options: {
  inputs: ActionInputs
  name: string
  info: NameInfo | null
  signer: string
  /**
   * Every address the viewer holds — what a new ownership is confirmed
   * against, because for the three "anyone" actions the app cannot know which
   * address will sign. `signerFor` answers `viewers[0]`; the Pay wallet signs
   * with whichever address holds the balance, which is never that one. So
   * `register` confirmed by comparing the new owner against an address that
   * had not signed, was false on every poll, and could not reach `confirmed`
   * at any timeout (seen on a real mainnet registration, 2026-08-21).
   */
  viewers: readonly string[]
  params: ApiParams | null
  apiBase: string
}): PreparedAction {
  const { inputs, name, info, signer, params, apiBase } = options
  // `signer` alone when a caller holds one address, which is also what keeps
  // the single-address callers and the tests honest.
  const viewers = options.viewers.length === 0 ? [signer] : options.viewers
  const ownedByViewer = (owner: string): boolean => viewers.some((address) => sameAddress(owner, address))
  const sender = parseAddress(signer)
  const record = info?.record ?? null

  const needParams = (): ApiParams => {
    if (params === null) throw new ActionInputError('The current fees could not be loaded — try again')
    return params
  }

  const asRequest = (built: BuiltTransaction): SubmitRequest => ({
    sender: signer,
    recipient: built.recipient,
    value: built.value,
    dataHex: built.data,
  })

  const infoNow = (): Promise<NameInfo | null> => getNameInfo(apiBase, name)

  switch (inputs.action) {
    case 'register': {
      const fee = registrationFee(name, needParams())
      // Inert by protocol (§6 `G`), so a ref that fails the syntax here is
      // dropped rather than refused — and the builder never sees it.
      const ref = inputs.ref != null && isReferralName(inputs.ref) ? inputs.ref : null
      return {
        action: 'register',
        request: asRequest(encodeRegister({ name, fee, sender, ...(ref === null ? {} : { ref }) })),
        review: [
          registerPaysLine(lunaToNim(fee), blocksApprox(CONSTANTS.TERM_LENGTH)),
          // §10.7: the referrer's share comes out of the treasury's fee, so
          // the payer sees who benefits and that the price is unchanged.
          ...(ref === null ? [] : [referredByLine(ref, percentOf(referralRateBp(ref, info?.height ?? 0) ?? 0))]),
        ],
        confirm: async () => {
          const rec = (await infoNow())?.record ?? null
          return rec !== null && ownedByViewer(rec.owner)
        },
      }
    }

    case 'renew': {
      const fee = registrationFee(name, needParams())
      const baseline = record?.expiry ?? 0
      return {
        action: 'renew',
        request: asRequest(encodeRenew({ name, fee, sender })),
        review: [
          `Pays ${lunaToNim(fee)} NIM.`,
          'Extends from the current expiry, not from today — renewing early costs nothing extra.',
          // A gift: anyone may renew (§6 `N`), and the payer must see that the
          // name stays where it is before the wallet opens.
          ...(record !== null && !ownedByViewer(record.owner) ? [giftRenewalLine(ellipsizeAddress(record.owner))] : []),
        ],
        confirm: async () => {
          const now = await infoNow()
          return (now?.record?.expiry ?? 0) > baseline
        },
      }
    }

    case 'setTarget': {
      const target = inputs.target === 'reset' ? null : parseAddress(requireAddress(inputs.target, 'The new target'))
      const expected: string = target === null ? signer : target
      return {
        action: 'setTarget',
        request: asRequest(encodeSetTarget({ name, target, sender })),
        review: [
          `Payments to ${name} will go to ${expected}.`,
          'Check the address on the wallet screen — it is the recipient of this transaction.',
        ],
        confirm: async () => {
          const rec = (await infoNow())?.record ?? null
          return rec !== null && sameAddress(rec.target, expected)
        },
      }
    }

    case 'setEvm': {
      // §6 E's client input rule lives in core: mixed-case input must carry a
      // valid EIP-55 checksum, and this is the only checksum the record ever
      // gets — the wire form is raw bytes.
      const evm = inputs.evm === 'clear' ? null : tryParseEvmAddress(inputs.evm)
      if (inputs.evm !== 'clear' && evm === null) {
        throw new ActionInputError(
          'Not an EVM address — 0x followed by 40 hex characters, with its checksum intact if mixed-case',
        )
      }
      return {
        action: 'setEvm',
        request: asRequest(encodeSetEvm({ name, evm, sender })),
        review: evm === null
          ? [`Removes the linked EVM address from ${name}.`]
          : [
              `USDC / USDT sent to ${name} on any EVM chain can use ${evm}.`,
              'One address covers Polygon, Ethereum, Arbitrum, Base and every other EVM chain.',
              'The registry records the address you declare — double-check it is yours.',
            ],
        confirm: async () => {
          const rec = (await infoNow())?.record ?? null
          return rec !== null && rec.evm === (evm ?? '')
        },
      }
    }

    case 'transfer': {
      const newOwner = requireAddress(inputs.newOwner, 'The new owner')
      if (sameAddress(newOwner, signer)) throw new ActionInputError('That is already the owning address')
      return {
        action: 'transfer',
        request: asRequest(encodeTransfer({ name, newOwner: parseAddress(newOwner), sender })),
        review: [
          `Ownership moves to ${newOwner} after ~12 h. Until then the name stays under your control, and Cancel can stop it.`,
          'A second transfer replaces this one and restarts the clock. The delay guards a mistyped address — it is not protection against a stolen key.',
        ],
        confirm: async () => {
          const pending = (await infoNow())?.pending.transfer ?? null
          return pending !== null && sameAddress(pending.newOwner, newOwner)
        },
      }
    }

    case 'delegate': {
      const host = inputs.host.trim()
      return {
        action: 'delegate',
        request: asRequest(encodeDelegate({ name, host, sender })),
        review: [
          host === ''
            ? `Subdomains under ${name} stop resolving.`
            : `${host} will answer for everything under ${name} — its answers are the host's word, not proven.`,
        ],
        confirm: async () => {
          const rec = (await infoNow())?.record ?? null
          return rec !== null && rec.host === host
        },
      }
    }

    case 'cancel': {
      const head = info?.height ?? 0
      const pendingTransfer = info?.pending.transfer ?? null
      const pendingOffer = info?.pending.offer ?? null
      // What the `K` will actually clear — never what is merely pending. An
      // offer inside `OFFER_IRREVOCABLE` survives it (§6 `O`), so counting it
      // promised a withdrawal the reducer refuses and then waited for an effect
      // that could not arrive: the confirm poll never passed and a `K` that had
      // done its job read as unconfirmed.
      const { transfer: cancelsTransfer, offer: cancelsOffer } = cancellableNow(info, head)
      const lines: string[] = []
      if (pendingTransfer !== null) lines.push(`Cancels the transfer to ${pendingTransfer.newOwner}.`)
      if (cancelsOffer && pendingOffer !== null) lines.push(`Withdraws the ${lunaToNim(pendingOffer.price)} NIM offer.`)
      if (!cancelsOffer && pendingOffer !== null) {
        lines.push(offerStaysLine(lunaToNim(pendingOffer.price), offerCancellableAt(pendingOffer.openedHeight) - head))
      }
      // Only where "everything" is more than one thing — and never above a line
      // that says what the `K` will leave standing.
      if (cancelsTransfer && cancelsOffer) lines.push('One cancel clears both, in one message.')
      return {
        action: 'cancel',
        request: asRequest(encodeCancel({ name, sender })),
        review: lines,
        confirm: async () => {
          const now = await infoNow()
          if (now === null) return false
          return (!cancelsTransfer || now.pending.transfer === null) && (!cancelsOffer || now.pending.offer === null)
        },
      }
    }

    case 'offer': {
      const price = parseNimPrice(inputs.priceNim)
      const minPrice = needParams().minPrice
      return {
        action: 'offer',
        request: asRequest(encodeOffer({ name, price, minPrice, sender })),
        review: [
          `Lists ${name} at ${lunaToNim(price)} NIM.`,
          'Irrevocable for ~2.4 hours, cancellable after, expires by itself in ~15 days.',
          'The marketplace takes its commission from the sale, not from listing.',
        ],
        confirm: async () => {
          const pending = (await infoNow())?.pending.offer ?? null
          return pending !== null && pending.price === price
        },
      }
    }

    case 'buy': {
      const offer = info?.pending.offer ?? null
      if (offer === null) throw new ActionInputError('No open offer on this name')
      if (record !== null && sameAddress(record.owner, signer)) throw new ActionInputError('This name is already yours')
      return {
        action: 'buy',
        request: asRequest(encodeBuy({ name, price: offer.price, sender })),
        review: [
          `Buys ${name} for ${lunaToNim(offer.price)} NIM, paid to the marketplace escrow.`,
          // The wallet sheet shows only the marketplace address (§5.3), so the
          // app is the one place the seller appears (docs/app-ux.md §5).
          soldByLine(offer.seller),
        ],
        confirm: async () => {
          const rec = (await infoNow())?.record ?? null
          return rec !== null && ownedByViewer(rec.owner)
        },
      }
    }

    case 'auction': {
      if (info === null || record === null) throw new ActionInputError('Couldn’t read this name’s record — try again')
      const startingPrice = parseNimAmount(inputs.startingPriceNim, 'Starting price')
      const endHeight = auctionEndHeight(info.height, parseAuctionDuration(inputs.durationDays))
      const minPrice = needParams().minPrice
      const when = (height: number): string => formatApproxDate(approxDate(height, info.height, Date.now()))
      const extension = blocksApprox(CONSTANTS.AUCTION_EXTENSION)
      const lines = [
        `Opens an auction on ${name} with a starting price of ${lunaToNim(startingPrice)} NIM, ending ${when(endHeight)}.`,
        `Neither the auction nor a bid can be withdrawn — it runs to the end, and a bid in the last ${extension} extends it by ${extension}.`,
        'The highest bid wins and the name transfers at the end; the proceeds arrive from the marketplace operator, less its commission.',
      ]
      // Opening voids both (§6 `A`) — the rule a later `O` or `X` already
      // applies to its predecessor — so the review says what goes.
      const pendingTransfer = info.pending.transfer
      const pendingOffer = info.pending.offer
      if (pendingTransfer !== null) lines.push(`Cancels the pending transfer to ${pendingTransfer.newOwner}.`)
      if (pendingOffer !== null) lines.push(`Withdraws the ${lunaToNim(pendingOffer.price)} NIM offer.`)
      // §6 A (2026-09-03): an auction sells the current term — an end at or past expiry forfeits AUCTION_BEYOND_TERM, so refuse here.
      if (auctionOutlivesTerm(endHeight, record.expiry)) throw new ActionInputError(auctionOutlivesTermLine(when(record.expiry)))
      return {
        action: 'auction',
        // `encodeAuction` refuses a starting price below `minPrice` (§6 `A`): the
        // increment rule rounds to zero at a token starting price.
        request: asRequest(encodeAuction({ name, startingPrice, endHeight, minPrice, sender })),
        review: lines,
        confirm: async () => {
          const pending = (await infoNow())?.pending.auction ?? null
          return pending !== null && pending.startingPrice === startingPrice
        },
      }
    }

    case 'bid': {
      const auction = info?.pending.auction ?? null
      if (info === null || auction === null) throw new ActionInputError('No open auction on this name')
      if (viewers.some((address) => sameAddress(auction.seller, address))) {
        throw new ActionInputError('This is your own auction')
      }
      const bid = parseNimAmount(inputs.bidNim, 'Bid')
      if (bid < auction.minimumBid) {
        throw new ActionInputError(`Bid must be at least ${lunaToNim(auction.minimumBid)} NIM`)
      }
      const when = (height: number): string => formatApproxDate(approxDate(height, info.height, Date.now()))
      const extension = blocksApprox(CONSTANTS.AUCTION_EXTENSION)
      return {
        action: 'bid',
        // The same `B` as a buy: state reads it as a bid because the auction
        // is open (§6 `A`). The client only shows which one it is sending.
        request: asRequest(encodeBuy({ name, price: bid, sender })),
        review: [
          `Bids ${lunaToNim(bid)} NIM on ${name}, held by the marketplace escrow until the auction ends ${when(auction.endHeight)}.`,
          `A bid in the last ${extension} extends the auction by ${extension}.`,
          bidRefundLine(),
          soldByLine(auction.seller),
        ],
        confirm: async () => {
          const now = (await infoNow())?.pending.auction ?? null
          return now !== null && now.bidder !== null && ownedByViewer(now.bidder) && now.bid === bid
        },
      }
    }
  }
}

/** The §5.4 dust every non-fee-bearing message carries — exported for the NC composer. */
export const DUST = CONSTANTS.DUST_VALUE
