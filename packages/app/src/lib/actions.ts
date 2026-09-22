/**
 * The docs/app-ux.md §5 flow table as code: for each action, how to build
 * the transaction (always `@nimiqnames/core` encoders — never a payload
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
  commissionOn,
  tryParseEvmAddress,
  type BuiltTransaction,
  termFor,
} from '@nimiqnames/core'
import { getNameInfo, type ApiParams, type NameInfo } from './api'
import { approxDate, blocksApprox, ellipsizeAddress, formatApproxWhen, looksGrouped, lunaToNim } from './format'
import {
  auctionOutlivesTermLine,
  auctionProceedsLine,
  auctionHint,
  bidHint,
  evmHint,
  offerHint,
  ownAddressTargetLine,
  renewHint,
  targetHint,
  transferHint,
  transferReplacesLine,
  offerRepricesLine,
  transferMovesLine,
  GATE_REASON_TEXT,
  alreadyOwnerLine,
  alreadyYoursLine,
  auctionTooLongLine,
  auctionTooShortLine,
  bidBelowMinimumLine,
  feesUnavailableLine,
  noHostTypedLine,
  noThousandsSeparatorLine,
  notADurationLine,
  notANimAmountLine,
  notAnAddressForLine,
  nothingToClearLine,
  ownAuctionLine,
  delegateClearedHint,
  delegateClearedLines,
  delegateSetHint,
  delegateSetLines,
  giftRenewalLine,
  newExpiryLine,
  referredByLine,
  registerLifetimePaysLine,
  registerPaysLine,
  termChoiceLabel,
  sellerProceedsLine,
  soldByLine,
} from './wording'
import { isReferralName } from './referral'
import { percentOf } from './referralRates'
import { rateIsNetOfBurn, rebatePercent } from './referralRates'
import { auctionEndHeight, auctionOutlivesTerm, cancellable, sameAddress, registrationFee } from './states'
import type { AppAction } from './states'
import type { SubmitRequest } from './wallet'

export type ActionInputs =
  | { readonly action: 'register'; readonly ref?: string | null | undefined; readonly lifetime?: boolean | undefined }
  | { readonly action: 'renew'; readonly lifetime?: boolean | undefined }
  | { readonly action: 'cancel' }
  | { readonly action: 'buy' }
  | { readonly action: 'setTarget'; readonly target: string | 'reset' }
  | { readonly action: 'setEvm'; readonly evm: string | 'clear' }
  | { readonly action: 'transfer'; readonly newOwner: string }
  | { readonly action: 'delegate'; readonly host: string | 'clear' }
  | { readonly action: 'offer'; readonly priceNim: string }
  | { readonly action: 'auction'; readonly startingPriceNim: string; readonly durationDays: string }
  | { readonly action: 'bid'; readonly bidNim: string }

export interface PreparedAction {
  readonly action: AppAction
  readonly request: SubmitRequest
  /** Lines the review screen adds to the generic ones (docs/app-ux.md §5). */
  readonly review: readonly string[]
  /** The why beside the last review line, behind the sheet's `(i)` bubble. */
  readonly reviewHint?: string
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
  const trimmed = text.trim()
  // Refused rather than interpreted — `looksGrouped` carries the argument.
  if (looksGrouped(trimmed)) {
    throw new ActionInputError(noThousandsSeparatorLine(what))
  }
  const match = /^([0-9]+)(?:[.,]([0-9]{1,5}))?$/.exec(trimmed)
  if (match === null || match[1] === undefined) throw new ActionInputError(notANimAmountLine(what))
  return BigInt(match[1]) * LUNA_PER_NIM + BigInt((match[2] ?? '').padEnd(5, '0'))
}

const parseNimPrice = (text: string): bigint => parseNimAmount(text)

/** The block clock's day, ~1 block/s — the same figure `format.ts` renders durations with. */
const BLOCKS_PER_DAY = 86_400

/**
 * An auction duration typed in days, to blocks. Two decimals — a quarter day
 * is the finest anyone plans a sale in — and never below `AUCTION_MIN_DURATION`
 * or above `AUCTION_MAX_DURATION`, which §6 `A` forfeits on. The landing
 * margin is added on top by `auctionEndHeight`, clamped to the cap, so both
 * bounds typed here are legal auctions.
 */
export const parseAuctionDuration = (text: string): number => {
  const match = /^([0-9]+)(?:[.,]([0-9]{1,2}))?$/.exec(text.trim())
  if (match === null || match[1] === undefined) throw new ActionInputError(notADurationLine())
  const hundredths = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  const blocks = Math.round((hundredths * BLOCKS_PER_DAY) / 100)
  if (blocks < CONSTANTS.AUCTION_MIN_DURATION) {
    throw new ActionInputError(auctionTooShortLine(blocksApprox(CONSTANTS.AUCTION_MIN_DURATION)))
  }
  if (blocks > CONSTANTS.AUCTION_MAX_DURATION) {
    throw new ActionInputError(auctionTooLongLine(blocksApprox(CONSTANTS.AUCTION_MAX_DURATION)))
  }
  return blocks
}

const requireAddress = (input: string, what: string): string => {
  const parsed = tryParseAddress(input)
  if (parsed === null) throw new ActionInputError(notAnAddressForLine(what))
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
  /** The clock the review's ≈ dates ride on; a test pins it. */
  nowMs?: number | undefined
}): PreparedAction {
  const { inputs, name, info, signer, params, apiBase } = options
  const nowMs = options.nowMs ?? Date.now()
  // `signer` alone when a caller holds one address, which is also what keeps
  // the single-address callers and the tests honest.
  const viewers = options.viewers.length === 0 ? [signer] : options.viewers
  const ownedByViewer = (owner: string): boolean => viewers.some((address) => sameAddress(owner, address))
  const sender = parseAddress(signer)
  const record = info?.record ?? null

  const needParams = (): ApiParams => {
    if (params === null) throw new ActionInputError(feesUnavailableLine())
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
      const lifetime = inputs.lifetime === true
      const fee = registrationFee(name, needParams(), lifetime)
      // Inert by protocol (§6 `G`), so a ref that fails the syntax here is
      // dropped rather than refused — and the builder never sees it.
      const ref = inputs.ref != null && isReferralName(inputs.ref) ? inputs.ref : null
      // A lifetime is a plain expiry a hundred terms out (§10.4) — the review
      // shows the date it actually is, measured from the head `/params` saw.
      const head = info?.height ?? needParams().height
      return {
        action: 'register',
        request: asRequest(
          encodeRegister({ name, fee, sender, ...(ref === null ? {} : { ref }), ...(lifetime ? { lifetime } : {}) }),
        ),
        review: [
          lifetime
            ? registerLifetimePaysLine(lunaToNim(fee), formatApproxWhen(approxDate(head + termFor(true), head, nowMs), nowMs))
            : // The same spelling as the choice above it: the tab says "1 year",
              // and `blocksApprox` said "~365 d" one line below it.
              registerPaysLine(lunaToNim(fee), termChoiceLabel()),
          // §10.7: the payer sees who referred them, that the price is
          // unchanged, and — the part the wallet's own screen cannot say —
          // that the rebate arrives afterwards, as a second transaction. The
          // rate is read at `head`, the same height the expiry line uses: a
          // `?? 0` here quoted the launch row's 10% with no rebate on every
          // review whose `/name` read had not landed (found by Rico's M1,
          // 2026-09-12).
          ...(ref === null ? [] : [referredByLine(ref, rebatePercent(ref, head), rateIsNetOfBurn(ref, head))]),
        ],
        confirm: async () => {
          const rec = (await infoNow())?.record ?? null
          return rec !== null && ownedByViewer(rec.owner)
        },
      }
    }

    case 'renew': {
      const lifetime = inputs.lifetime === true
      const fee = registrationFee(name, needParams(), lifetime)
      const baseline = record?.expiry ?? 0
      return {
        action: 'renew',
        request: asRequest(encodeRenew({ name, fee, sender, ...(lifetime ? { lifetime } : {}) })),
        review: [
          `Pays ${lunaToNim(fee)} NIM.`,
          // Where the clock lands, as a date: for a lifetime the only honest
          // rendering of a hundred terms, and for a term the same line. That
          // it extends from the expiry rather than from today is the *why*,
          // and it moved behind the bubble with the rest of the second
          // sentences (Rico, 2026-09-15).
          ...(record !== null && info !== null
            ? [newExpiryLine(formatApproxWhen(approxDate(record.expiry + termFor(lifetime), info.height, nowMs), nowMs))]
            : []),
          // A gift: anyone may renew (§6 `N`), and the payer must see that the
          // name stays where it is before the wallet opens.
          ...(record !== null && !ownedByViewer(record.owner) ? [giftRenewalLine(ellipsizeAddress(record.owner))] : []),
        ],
        reviewHint: renewHint(),
        confirm: async () => {
          const now = await infoNow()
          return (now?.record?.expiry ?? 0) > baseline
        },
      }
    }

    case 'setTarget': {
      // Typing your own address is what the checkbox is for, and since the
      // field takes a name (2026-09-15) it is easy to arrive at by naming a
      // name of your own. `S` carries the target as the **recipient** (§5.3),
      // so this would otherwise reach `core` and come back as its internal
      // "sender and recipient must differ", which is a sentence about
      // transactions to someone reading about their name.
      if (inputs.target !== 'reset' && tryParseAddress(inputs.target) !== null && sameAddress(inputs.target, signer)) {
        throw new ActionInputError(ownAddressTargetLine())
      }
      const target = inputs.target === 'reset' ? null : parseAddress(requireAddress(inputs.target, 'The new target'))
      const expected: string = target === null ? signer : target
      return {
        action: 'setTarget',
        request: asRequest(encodeSetTarget({ name, target, sender })),
        review: [`Payments to ${name} will go to ${expected}.`],
        reviewHint: targetHint(),
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
          'Not an EVM address. It is 0x followed by 40 hex characters, with its checksum intact if mixed-case.',
        )
      }
      return {
        action: 'setEvm',
        request: asRequest(encodeSetEvm({ name, evm, sender })),
        review: evm === null
          ? [`Removes the linked EVM address from ${name}.`]
          : [`USDC and USDT sent to ${name} on any EVM chain go to ${evm}.`],
        ...(evm === null ? {} : { reviewHint: evmHint() }),
        confirm: async () => {
          const rec = (await infoNow())?.record ?? null
          return rec !== null && rec.evm === (evm ?? '')
        },
      }
    }

    case 'transfer': {
      const newOwner = requireAddress(inputs.newOwner, 'The new owner')
      if (sameAddress(newOwner, signer)) throw new ActionInputError(alreadyOwnerLine())
      const replaced = info?.pending.transfer ?? null
      return {
        action: 'transfer',
        request: asRequest(encodeTransfer({ name, newOwner: parseAddress(newOwner), sender })),
        // A second X replaces the pending one and restarts the clock (§7.3):
        // the review names what it replaces, not only where it goes.
        review: [
          replaced === null
            ? transferMovesLine(blocksApprox(CONSTANTS.XFER_TIMELOCK))
            : transferReplacesLine(replaced.newOwner, blocksApprox(CONSTANTS.XFER_TIMELOCK)),
        ],
        reviewHint: transferHint(),
        confirm: async () => {
          const pending = (await infoNow())?.pending.transfer ?? null
          return pending !== null && sameAddress(pending.newOwner, newOwner)
        },
      }
    }

    case 'delegate': {
      // `'clear'` is the checkbox, as it is for `E`: an empty field is a sheet
      // nobody has filled in, not an instruction (2026-09-15).
      const clearing = inputs.host === 'clear'
      const host = clearing ? '' : inputs.host.trim()
      if (!clearing && host === '') throw new ActionInputError(noHostTypedLine())
      // Clearing a name that has no host is a `D` that changes nothing — a
      // paid transaction whose whole effect is to rewrite the record with the
      // value it already holds. A null record means the fetch failed, and
      // refusing a real clear on a network error is the worse mistake, so the
      // guard only fires on a record that answered.
      if (clearing && record !== null && record.host === '') {
        throw new ActionInputError(nothingToClearLine())
      }
      return {
        action: 'delegate',
        request: asRequest(encodeDelegate({ name, host, sender })),
        review: [...(clearing ? delegateClearedLines(name) : delegateSetLines(host, name))],
        reviewHint: clearing ? delegateClearedHint() : delegateSetHint(host),
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
      // The name's one pending thing (§7.3, r30), which is what the `K` clears.
      const clears = cancellable(info)
      const lines: string[] = []
      // The window, not just the intent: a transfer's timelock is 10 min in a
      // tempo era and 12 h on mainnet, and the sheet used to leave it to guess
      // (Rico, 2026-09-15).
      if (clears === 'transfer' && pendingTransfer !== null) {
        lines.push(`Cancels the transfer to ${pendingTransfer.newOwner} (${blocksApprox(pendingTransfer.effectiveHeight - head)} left).`)
      }
      if (clears === 'sale' && pendingOffer !== null) lines.push(`Takes it off sale (was ${lunaToNim(pendingOffer.price)} NIM).`)
      return {
        action: 'cancel',
        request: asRequest(encodeCancel({ name, sender })),
        review: lines,
        confirm: async () => {
          const now = await infoNow()
          if (now === null) return false
          return clears === 'transfer' ? now.pending.transfer === null : clears === 'sale' ? now.pending.offer === null : true
        },
      }
    }

    case 'offer': {
      const price = parseNimPrice(inputs.priceNim)
      const minPrice = needParams().minPrice
      // The rate is the one `/params` served, run through the reducer's own
      // `commissionOn` — floor rounding, remainder to the seller. Restating
      // `CONSTANTS.COMMISSION_RATE` here would survive a `P` as a wrong number
      // on screen (§10.6).
      const commissionBp = needParams().prices.commissionBp
      const repriced = info?.pending.offer ?? null
      return {
        action: 'offer',
        request: asRequest(encodeOffer({ name, price, minPrice, sender })),
        review: [
          repriced === null
            ? `Puts ${name} up for sale at ${lunaToNim(price)} NIM.`
            : offerRepricesLine(name, lunaToNim(repriced.price), lunaToNim(price)),
          sellerProceedsLine(lunaToNim(price - commissionOn(price, commissionBp)), percentOf(Number(commissionBp))),
        ],
        reviewHint: offerHint(),
        confirm: async () => {
          const pending = (await infoNow())?.pending.offer ?? null
          return pending !== null && pending.price === price
        },
      }
    }

    case 'buy': {
      const offer = info?.pending.offer ?? null
      if (offer === null) throw new ActionInputError(GATE_REASON_TEXT['no-offer'])
      if (record !== null && sameAddress(record.owner, signer)) throw new ActionInputError(alreadyYoursLine())
      return {
        action: 'buy',
        request: asRequest(encodeBuy({ name, price: offer.price, sender })),
        review: [
          `Buys ${name} for ${lunaToNim(offer.price)} NIM, paid into the marketplace escrow.`,
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
      if (info === null || record === null) throw new ActionInputError(GATE_REASON_TEXT['state-unknown'])
      const startingPrice = parseNimAmount(inputs.startingPriceNim, 'Starting price')
      const endHeight = auctionEndHeight(info.height, parseAuctionDuration(inputs.durationDays))
      const minPrice = needParams().minPrice
      const when = (height: number): string => formatApproxWhen(approxDate(height, info.height, Date.now()), Date.now())
      const extension = blocksApprox(CONSTANTS.AUCTION_EXTENSION)
      const lines = [
        `Auctions ${name} from ${lunaToNim(startingPrice)} NIM, ending ${when(endHeight)}.`,
        // A minimum, not a figure: the starting price is the floor the first
        // bid must meet, and the winning bid can only be higher.
        auctionProceedsLine(
          lunaToNim(startingPrice - commissionOn(startingPrice, needParams().prices.commissionBp)),
          percentOf(Number(needParams().prices.commissionBp)),
        ),
      ]
      // Opening voids both (§6 `A`) — the rule a later `O` or `X` already
      // applies to its predecessor — so the review says what goes.
      const pendingTransfer = info.pending.transfer
      const pendingOffer = info.pending.offer
      if (pendingTransfer !== null) lines.push(`Cancels the pending transfer to ${pendingTransfer.newOwner}.`)
      if (pendingOffer !== null) lines.push(`Takes it off sale (was ${lunaToNim(pendingOffer.price)} NIM).`)
      // §6 A (2026-09-03): an auction sells the current term — an end at or past expiry forfeits AUCTION_BEYOND_TERM, so refuse here.
      if (auctionOutlivesTerm(endHeight, record.expiry)) throw new ActionInputError(auctionOutlivesTermLine(when(record.expiry)))
      return {
        action: 'auction',
        // `encodeAuction` refuses a starting price below `minPrice` (§6 `A`): the
        // increment rule rounds to zero at a token starting price.
        request: asRequest(encodeAuction({ name, startingPrice, endHeight, minPrice, sender })),
        review: lines,
        reviewHint: auctionHint(extension),
        confirm: async () => {
          const pending = (await infoNow())?.pending.auction ?? null
          return pending !== null && pending.startingPrice === startingPrice
        },
      }
    }

    case 'bid': {
      const auction = info?.pending.auction ?? null
      if (info === null || auction === null) throw new ActionInputError(GATE_REASON_TEXT['no-auction'])
      if (viewers.some((address) => sameAddress(auction.seller, address))) {
        throw new ActionInputError(ownAuctionLine())
      }
      const bid = parseNimAmount(inputs.bidNim, 'Bid')
      if (bid < auction.minimumBid) {
        throw new ActionInputError(bidBelowMinimumLine(lunaToNim(auction.minimumBid)))
      }
      const when = (height: number): string => formatApproxWhen(approxDate(height, info.height, Date.now()), Date.now())
      const extension = blocksApprox(CONSTANTS.AUCTION_EXTENSION)
      return {
        action: 'bid',
        // The same `B` as a buy: state reads it as a bid because the auction
        // is open (§6 `A`). The client only shows which one it is sending.
        request: asRequest(encodeBuy({ name, price: bid, sender })),
        review: [
          `Bids ${lunaToNim(bid)} NIM on ${name}, held in escrow until it ends ${when(auction.endHeight)}.`,
          soldByLine(auction.seller),
        ],
        reviewHint: bidHint(extension),
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
