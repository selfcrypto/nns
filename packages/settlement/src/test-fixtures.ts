/**
 * A staged §8.2 log, built the way the chain builds one.
 *
 * Transactions go through `core`'s builders for their recipient, value and
 * payload, through `core.reduce` for their verdict, and through
 * `core.canonicalLogLine` for their line — so a fixture cannot encode a message
 * one way and the reducer read it another. What the reconciler then gets is a
 * list of strings and nothing else, which is exactly what it gets in
 * production.
 *
 * This lives in `src/` rather than beside one test because both the replay and
 * the reconcile suites need the same scenario, and a second copy of it would be
 * a second definition of what the money is supposed to do.
 */

import {
  addressFromBytes,
  canonicalLogLine,
  defineConfig,
  initialState,
  reduce,
  type Address,
  type BuiltTransaction,
  type ChainTransaction,
  type NnsConfig,
  type NnsState,
} from '@nns/core'

/** Distinct, valid, and never the all-zero burn address. */
export function testAddress(seed: number): Address {
  if (seed < 1 || seed > 255) throw new Error(`test address seed ${seed} out of range — 0 is BURN_ADDRESS`)
  const bytes = new Uint8Array(20)
  bytes[19] = seed
  return addressFromBytes(bytes)
}

export const TREASURY = testAddress(1)
export const PROTOCOL = testAddress(2)
export const ADMIN = testAddress(3)
export const MARKETPLACE = testAddress(4)
export const SELLER = testAddress(10)
export const WINNER = testAddress(11)
export const LOSER = testAddress(12)

export const LAUNCH_HEIGHT = 1_000_000
export const NETWORK_ID = 5

export const testConfig = (overrides: Partial<Parameters<typeof defineConfig>[0]> = {}): NnsConfig =>
  defineConfig({
    networkId: NETWORK_ID,
    launchHeight: LAUNCH_HEIGHT,
    treasury: TREASURY,
    protocol: PROTOCOL,
    admin: ADMIN,
    marketplace: MARKETPLACE,
    listingFee: 100_000n,
    reservedNames: ['binance'],
    ...overrides,
  })

/** A hash is only ever echoed, so a deterministic stand-in keeps lines stable. */
const fakeHash = (height: number, txIndex: number): string =>
  `${height.toString(16).padStart(32, '0')}${txIndex.toString(16).padStart(32, '0')}`

export interface Send {
  readonly height: number
  readonly txIndex: number
  readonly sender: Address
  readonly built: BuiltTransaction
}

export const send = (height: number, txIndex: number, sender: Address, built: BuiltTransaction): Send => ({
  height,
  txIndex,
  sender,
  built,
})

function toChainTransaction(item: Send, config: NnsConfig): ChainTransaction {
  return {
    blockNumber: item.height,
    txIndex: item.txIndex,
    hash: fakeHash(item.height, item.txIndex),
    sender: item.sender,
    recipient: item.built.recipient,
    value: item.built.value,
    recipientData: item.built.data,
    executionResult: true,
    networkId: config.networkId,
    isReward: false,
  }
}

export interface StagedLog {
  readonly lines: readonly string[]
  /** The state the staging run ended on — the answer the reconciler must reach. */
  readonly state: NnsState
}

/** Reduce every send in order and emit the log line each one earns (§7.6). */
export function stageLog(sends: readonly Send[], config: NnsConfig): StagedLog {
  let state = initialState(config)
  const lines: string[] = []
  for (const item of sends) {
    const tx = toChainTransaction(item, config)
    const result = reduce(state, tx, config)
    state = result.state
    if (result.verdict.kind === 'IGNORED') throw new Error(`fixture send at ${item.height}:${item.txIndex} was ignored`)
    lines.push(canonicalLogLine(tx, result.verdict))
  }
  return { lines, state }
}
