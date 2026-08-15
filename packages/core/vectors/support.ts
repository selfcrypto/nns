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
  }
}

export interface BuildSpec {
  builder: string
  fee?: string
  ref?: string
  target?: string | null
  newOwner?: string
  host?: string
  price?: string
  /** §3 MIN_PRICE for the case. Defaults to FEE_LONG at launch prices. */
  minPrice?: string
  payee?: string
  amount?: string
  reserve?: string
  endHeight?: number
  feeStandard?: string
  feeLong?: string
  commissionBp?: string
  effectiveHeight?: number
  name?: string
  sender?: string
  /** `U` only: the awardee, or `null`/absent for a release (§6 `U`, r17). */
  recipient?: string | null
}

/**
 * §3 `MIN_PRICE` for a build spec. It is `FEE_LONG` *in effect at the message's
 * height* (§6 `O`), so a case that has moved `FEE_LONG` with a `P` states its
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
        ...sender,
      })
    case 'setTarget':
      return encodeSetTarget({ name, target: optionalAddress(book, spec.target), ...sender })
    case 'transfer':
      return encodeTransfer({ name, newOwner: address(book, spec.newOwner as string), ...sender })
    case 'delegate':
      return encodeDelegate({ name, host: spec.host as string, ...sender })
    case 'cancel':
      return encodeCancel({ name, ...sender })
    case 'renew':
      return encodeRenew({ name, fee: BigInt(spec.fee as string), ...sender })
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
        height: 58903520,
        txIndex: 0,
        payee: address(book, spec.payee as string),
        amount: BigInt(spec.amount as string),
        ...sender,
      })
    case 'auction':
      return encodeAuction({
        name,
        reserve: BigInt(spec.reserve as string),
        endHeight: spec.endHeight as number,
        minPrice: floorFor(spec),
        ...sender,
      })
    case 'governance':
      return encodeGovernance({
        feeStandard: BigInt(spec.feeStandard as string),
        feeLong: BigInt(spec.feeLong as string),
        commissionBp: BigInt(spec.commissionBp as string),
        effectiveHeight: spec.effectiveHeight as number,
        ...sender,
      })
    case 'unreserve':
      return encodeUnreserve({
        name,
        effectiveHeight: spec.effectiveHeight as number,
        recipient: optionalAddress(book, spec.recipient),
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
  expiry: number
  status: 'REGISTERED' | 'GRACE'
  host: string
}

export const readRecord = (raw: VectorRecord, book: AddressBook): NameRecord => ({
  name: raw.name,
  owner: address(book, raw.owner),
  target: address(book, raw.target),
  expiry: raw.expiry,
  status: raw.status,
  host: raw.host,
})

// ── Whole-state vectors, for the §8.1 checkpoint commitment ─────────────────

interface VectorPrices {
  feeStandard: string
  feeLong: string
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
  pendingGovernance?: { prices: VectorPrices; effectiveHeight: number } | null
  /** `recipient: null` is a release; an address is the awardee (§6 `U`, r17). */
  pendingUnreserve?: Array<{ name: string; recipient: string | null; effectiveHeight: number }>
  /** Names whose `U` has fired (§8.1 tag `0x0A`). Authored unsorted where the case is about ordering. */
  unreserved?: string[]
}

const readPrices = (raw: VectorPrices): Prices => ({
  feeStandard: BigInt(raw.feeStandard),
  feeLong: BigInt(raw.feeLong),
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
    pendingGovernance:
      raw.pendingGovernance == null
        ? null
        : { prices: readPrices(raw.pendingGovernance.prices), effectiveHeight: raw.pendingGovernance.effectiveHeight },
    pendingUnreserve: byName(
      (raw.pendingUnreserve ?? []).map((item) => ({ ...item, recipient: optionalAddress(book, item.recipient) })),
    ),
    unreserved: new Set(raw.unreserved ?? []),
  })
}
