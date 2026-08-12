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
  encodeRecovery,
  encodeRegister,
  encodeRenew,
  encodeSetTarget,
  encodeSettlement,
  encodeTransfer,
  encodeUnreserve,
} from '../src/codec.js'
import { type NnsConfig, defineConfig } from '../src/config.js'
import type { ChainTransaction } from '../src/reduce.js'
import type { NameRecord } from '../src/state.js'

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
  launchHeight: number
  treasury: string
  protocol: string
  admin: string
  marketplace: string
  listingFee: string
  reservedNames?: string[]
}

export const readConfig = (raw: VectorConfig, book: AddressBook): NnsConfig =>
  defineConfig({
    networkId: raw.networkId,
    launchHeight: raw.launchHeight,
    treasury: address(book, raw.treasury),
    protocol: address(book, raw.protocol),
    admin: address(book, raw.admin),
    marketplace: address(book, raw.marketplace),
    listingFee: BigInt(raw.listingFee),
    reservedNames: raw.reservedNames ?? [],
  })

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
  recovery?: string | null
  host?: string
  price?: string
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
}

const optionalAddress = (book: AddressBook, alias: string | null | undefined): Address | null =>
  alias === null || alias === undefined ? null : address(book, alias)

/** Dispatch a vector's `build` spec to the matching §6 builder. */
export function build(config: NnsConfig, spec: BuildSpec, name: string, book: AddressBook): BuiltTransaction {
  const sender = spec.sender === undefined ? {} : { sender: address(book, spec.sender) }
  switch (spec.builder) {
    case 'register':
      return encodeRegister(config, {
        name,
        ...(spec.ref === undefined ? {} : { ref: spec.ref }),
        fee: BigInt(spec.fee ?? '1'),
        ...sender,
      })
    case 'setTarget':
      return encodeSetTarget(config, { name, target: optionalAddress(book, spec.target), ...sender })
    case 'transfer':
      return encodeTransfer(config, { name, newOwner: address(book, spec.newOwner as string), ...sender })
    case 'recovery':
      return encodeRecovery(config, { name, recovery: optionalAddress(book, spec.recovery), ...sender })
    case 'delegate':
      return encodeDelegate(config, { name, host: spec.host as string, ...sender })
    case 'cancel':
      return encodeCancel(config, { name, ...sender })
    case 'renew':
      return encodeRenew(config, { name, fee: BigInt(spec.fee as string), ...sender })
    case 'offer':
      return encodeOffer(config, { name, price: BigInt(spec.price as string), ...sender })
    case 'buy':
      return encodeBuy(config, { name, price: BigInt(spec.price as string), ...sender })
    case 'settlement':
      return encodeSettlement(config, {
        height: 58060800,
        txIndex: 0,
        payee: address(book, spec.payee as string),
        amount: BigInt(spec.amount as string),
        ...sender,
      })
    case 'auction':
      return encodeAuction(config, {
        name,
        reserve: BigInt(spec.reserve as string),
        endHeight: spec.endHeight as number,
        ...sender,
      })
    case 'governance':
      return encodeGovernance(config, {
        feeStandard: BigInt(spec.feeStandard as string),
        feeLong: BigInt(spec.feeLong as string),
        commissionBp: BigInt(spec.commissionBp as string),
        effectiveHeight: spec.effectiveHeight as number,
        ...sender,
      })
    case 'unreserve':
      return encodeUnreserve(config, { name, effectiveHeight: spec.effectiveHeight as number, ...sender })
    case 'burn':
      return encodeBurn(config, { amount: BigInt(spec.amount as string), ...sender })
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
  recovery: string | null
  host: string
}

export const readRecord = (raw: VectorRecord, book: AddressBook): NameRecord => ({
  name: raw.name,
  owner: address(book, raw.owner),
  target: address(book, raw.target),
  expiry: raw.expiry,
  status: raw.status,
  recovery: optionalAddress(book, raw.recovery),
  host: raw.host,
})
