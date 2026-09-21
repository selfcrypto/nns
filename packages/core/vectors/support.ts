/**
 * Helpers shared by the vector runner and the fill script, so both resolve
 * aliases, configs and transactions exactly one way.
 *
 * Excluded from the build — see `tsconfig.json`.
 */

import { type Address, parseAddress } from '../src/address.js'
import {
  type BuiltTransaction,
  encodeAuction,
  encodeBurn,
  encodeBuy,
  encodeCancel,
  encodeDelegate,
  encodeGovernance,
  encodeOffer,
  encodeRegister,
  encodeRenew,
  encodeSetEvm,
  encodeSetTarget,
  encodeSettlement,
  encodeTransfer,
  encodeUnreserve,
} from '../src/codec.js'
import { type NnsConfig, defineConfig } from '../src/config.js'
import type { ChainTransaction } from '../src/reduce.js'
import {
  LAUNCH_PRICES,
  type NameRecord,
  type NnsState,
  type Prices,
  initialState,
  minPrice,
} from '../src/state.js'

export type AddressBook = Readonly<Record<string, Address>>

export const readAddresses = (raw: Readonly<Record<string, string>>): AddressBook =>
  Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, parseAddress(value)]))

/** An alias from the vector's `addresses` map, or a literal `NQ…` string. */
export function address(book: AddressBook, alias: string): Address {
  const known = book[alias]
  return known ?? parseAddress(alias)
}

export interface VectorConfig {
  networkId: number
}

/**
 * Since the launch freeze a vector declares only `networkId`: the §3
 * addresses and `LAUNCH_HEIGHT` are constants, so the vectors exercise the
 * frozen values — their transactions route to `CONSTANTS.TREASURY_ADDRESS`
 * et al. via the address book, and their heights sit above
 * `CONSTANTS.LAUNCH_HEIGHT`.
 */
export const readConfig = (raw: VectorConfig, _book: AddressBook): NnsConfig =>
  defineConfig({ networkId: raw.networkId })

/** ASCII → lowercase hex. Vectors carry `text` for review and `data` for machines. */
export const hexOf = (text: string): string =>
  [...text].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')

export interface VectorTx {
  blockNumber: number
  txIndex: number
  hash?: string
  sender: string
  recipient: string
  value: string
  /** The message as ASCII. Mutually exclusive with `data`. */
  text?: string
  /** Raw hex, for payloads that are not ASCII-authorable. */
  data?: string
  executionResult?: boolean
  isReward?: boolean
  networkId?: number
  /** §7.2 attribution (r25): the sender's Nimiq account type and the tx proof, hex. */
  senderType?: number
  proof?: string
}

export function readTx(raw: VectorTx, book: AddressBook, defaultNetworkId: number): ChainTransaction {
  const recipientData = raw.data ?? hexOf(raw.text ?? '')
  return {
    blockNumber: raw.blockNumber,
    txIndex: raw.txIndex,
    hash: raw.hash ?? `${raw.blockNumber.toString(16)}${raw.txIndex}`.padEnd(64, '0'),
    sender: address(book, raw.sender),
    recipient: address(book, raw.recipient),
    value: BigInt(raw.value),
    recipientData,
    executionResult: raw.executionResult ?? true,
    networkId: raw.networkId ?? defaultNetworkId,
    ...(raw.isReward === undefined ? {} : { isReward: raw.isReward }),
    ...(raw.senderType === undefined ? {} : { senderType: raw.senderType }),
    ...(raw.proof === undefined ? {} : { proof: raw.proof }),
  }
}

export interface BuildSpec {
  builder: string
  fee?: string
  ref?: string
  target?: string | null
  newOwner?: string
  host?: string
  /** `E` only: `0x`-hex display form, or `null` to clear (§6 `E`). */
  evm?: string | null
  price?: string
  /** §3 MIN_PRICE for the case. Defaults to FEE_BASE at launch prices. */
  minPrice?: string
  payee?: string
  amount?: string
  startingPrice?: string
  endHeight?: number
  feeBase?: string
  commissionBp?: string
  effectiveHeight?: number
  name?: string
  sender?: string
  /** `U` only: the awardee, or `null`/absent for a release (§6 `U`, r17). */
  recipient?: string | null
  /** `G`, `N`, `U`: the trailing `L` — a lifetime term (§10.4). */
  lifetime?: boolean
}

/**
 * §3 `MIN_PRICE` for a build spec. It is `FEE_BASE` *in effect at the message's
 * height* (§6 `O`), so a case that has moved `FEE_BASE` with a `P` states its
 * own; everything else gets the launch value.
 */
const floorFor = (spec: BuildSpec): bigint =>
  spec.minPrice === undefined ? minPrice(LAUNCH_PRICES) : BigInt(spec.minPrice)

const optionalAddress = (book: AddressBook, alias: string | null | undefined): Address | null =>
  alias === null || alias === undefined ? null : address(book, alias)

/** Dispatch a vector's `build` spec to the matching §6 builder. */
export function build(config: NnsConfig, spec: BuildSpec, name: string, book: AddressBook): BuiltTransaction {
  const sender = spec.sender === undefined ? {} : { sender: address(book, spec.sender) }
  switch (spec.builder) {
    case 'register':
      return encodeRegister({
        name,
        ...(spec.ref === undefined ? {} : { ref: spec.ref }),
        fee: BigInt(spec.fee ?? '1'),
        ...(spec.lifetime === undefined ? {} : { lifetime: spec.lifetime }),
        ...sender,
      })
    case 'setTarget':
      return encodeSetTarget({ name, target: optionalAddress(book, spec.target), ...sender })
    case 'setEvm':
      return encodeSetEvm({ name, evm: spec.evm ?? null, ...sender })
    case 'transfer':
      return encodeTransfer({ name, newOwner: address(book, spec.newOwner as string), ...sender })
    case 'delegate':
      return encodeDelegate({ name, host: spec.host as string, ...sender })
    case 'cancel':
      return encodeCancel({ name, ...sender })
    case 'renew':
      return encodeRenew({
        name,
        fee: BigInt(spec.fee as string),
        ...(spec.lifetime === undefined ? {} : { lifetime: spec.lifetime }),
        ...sender,
      })
    case 'offer':
      return encodeOffer({
        name,
        price: BigInt(spec.price as string),
        minPrice: floorFor(spec),
        ...sender,
      })
    case 'buy':
      return encodeBuy({ name, price: BigInt(spec.price as string), ...sender })
    case 'settlement':
      return encodeSettlement({
        height: 62336480,
        txIndex: 0,
        payee: address(book, spec.payee as string),
        amount: BigInt(spec.amount as string),
        ...sender,
      })
    case 'auction':
      return encodeAuction({
        name,
        startingPrice: BigInt(spec.startingPrice as string),
        endHeight: spec.endHeight as number,
        minPrice: floorFor(spec),
        ...sender,
      })
    case 'governance':
      return encodeGovernance({
        feeBase: BigInt(spec.feeBase as string),
        commissionBp: BigInt(spec.commissionBp as string),
        effectiveHeight: spec.effectiveHeight as number,
        ...sender,
      })
    case 'unreserve':
      return encodeUnreserve({
        name,
        recipient: optionalAddress(book, spec.recipient),
        ...(spec.lifetime === undefined ? {} : { lifetime: spec.lifetime }),
        ...sender,
      })
    case 'burn':
      return encodeBurn({ amount: BigInt(spec.amount as string), ...sender })
    default:
      throw new Error(`unknown builder ${JSON.stringify(spec.builder)}`)
  }
}

export interface VectorRecord {
  name: string
  owner: string
  target: string
  /** Lowercase `0x`-hex; absent or `''` is unset — 20 zero bytes in the leaf (§8.1, r26). */
  evm?: string
  expiry: number
  status: 'REGISTERED' | 'GRACE'
  host: string
}

export const readRecord = (raw: VectorRecord, book: AddressBook): NameRecord => ({
  name: raw.name,
  owner: address(book, raw.owner),
  target: address(book, raw.target),
  evm: raw.evm ?? '',
  expiry: raw.expiry,
  status: raw.status,
  host: raw.host,
})

// ── Whole-state vectors, for the §8.1 checkpoint commitment ─────────────────

interface VectorPrices {
  feeBase: string
  commissionBp: string
}

/**
 * Everything §8.1 requires a checkpoint to commit to. Deliberately not the
 * whole of `NnsState`: `outstanding`, `lastGovernanceHeight` and
 * `nextDueHeight` are outside the commitment, so a vector that named them
 * would suggest they are inside it. `unreserved` was in that list until r16
 * put it inside the commitment under tag `0x0A`.
 */
export interface VectorCheckpointState {
  height: number
  prices: VectorPrices
  names?: VectorRecord[]
  transfers?: Array<{ name: string; newOwner: string; effectiveHeight: number }>
  offers?: Array<{ name: string; seller: string; price: string; openedHeight: number; expiryHeight: number }>
  /** Open auctions (§8.1 tag `0x0B`, r28). `bidder` absent or `null` means no bid has met the starting price. */
  auctions?: Array<{ name: string; seller: string; startingPrice: string; endHeight: number; bidder?: string | null; bid?: string }>
  pendingGovernance?: { prices: VectorPrices; effectiveHeight: number } | null
  /** Names whose `U` has fired (§8.1 tag `0x0A`). Authored unsorted where the case is about ordering. */
  unreserved?: string[]
}

const readPrices = (raw: VectorPrices): Prices => ({
  feeBase: BigInt(raw.feeBase),
  commissionBp: BigInt(raw.commissionBp),
})

const byName = <T extends { name: string }>(items: readonly T[]): Map<string, T> =>
  new Map(items.map((item) => [item.name, item]))

export function readCheckpointState(
  raw: VectorCheckpointState,
  book: AddressBook,
  config: NnsConfig,
): NnsState {
  return Object.freeze({
    ...initialState(),
    height: raw.height,
    prices: readPrices(raw.prices),
    names: byName((raw.names ?? []).map((record) => readRecord(record, book))),
    transfers: byName(
      (raw.transfers ?? []).map((item) => ({ ...item, newOwner: address(book, item.newOwner) })),
    ),
    offers: byName(
      (raw.offers ?? []).map((item) => ({ ...item, seller: address(book, item.seller), price: BigInt(item.price) })),
    ),
    auctions: byName(
      (raw.auctions ?? []).map((item) => ({
        name: item.name,
        seller: address(book, item.seller),
        startingPrice: BigInt(item.startingPrice),
        endHeight: item.endHeight,
        bidder: item.bidder == null ? null : address(book, item.bidder),
        bid: BigInt(item.bid ?? '0'),
        // Settlement identity, outside the commitment (§8.1) — a checkpoint
        // vector cannot name it, and the value here never reaches a digest.
        bidRef: null,
      })),
    ),
    pendingGovernance:
      raw.pendingGovernance == null
        ? null
        : { prices: readPrices(raw.pendingGovernance.prices), effectiveHeight: raw.pendingGovernance.effectiveHeight },
    unreserved: new Set(raw.unreserved ?? []),
  })
}
