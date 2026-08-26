/**
 * The docs/app-ux.md §5 flow table as code: for each action, how to build
 * the transaction (always `@nns/core` encoders — never a payload
 * concatenated here), what the review screen must say beyond the generic
 * lines, and which visible effect confirms it. Pure except the confirm
 * closures, which read the API.
 */

import {
  CONSTANTS,
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
import { lunaToNim } from './format'
import { soldByLine } from './wording'
import { sameAddress, registrationFee } from './states'
import type { AppAction } from './states'
import type { SubmitRequest } from './wallet'

export type ActionInputs =
  | { readonly action: 'register' }
  | { readonly action: 'renew' }
  | { readonly action: 'cancel' }
  | { readonly action: 'buy' }
  | { readonly action: 'setTarget'; readonly target: string | 'reset' }
  | { readonly action: 'setEvm'; readonly evm: string | 'clear' }
  | { readonly action: 'transfer'; readonly newOwner: string }
  | { readonly action: 'delegate'; readonly host: string }
  | { readonly action: 'offer'; readonly priceNim: string }

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
      return {
        action: 'register',
        request: asRequest(encodeRegister({ name, fee, sender })),
        review: [`Pays ${lunaToNim(fee)} NIM to the registry for a one-year term.`],
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
      const pendingTransfer = info?.pending.transfer ?? null
      const pendingOffer = info?.pending.offer ?? null
      const cancelsTransfer = pendingTransfer !== null
      const cancelsOffer = pendingOffer !== null
      const lines: string[] = []
      if (pendingTransfer !== null) lines.push(`Cancels the transfer to ${pendingTransfer.newOwner}.`)
      if (pendingOffer !== null) lines.push(`Withdraws the ${lunaToNim(pendingOffer.price)} NIM offer.`)
      lines.push('One cancel clears everything listed above.')
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
  }
}

/** The §5.4 dust every non-fee-bearing message carries — exported for the NC composer. */
export const DUST = CONSTANTS.DUST_VALUE
