import { describe, expect, it } from 'vitest'
import { AddressError, BURN_ADDRESS, CodecError, CONSTANTS, defineConfig, encodeUnreserve, parseAddress } from '@nns/core'

import { UsageError, type AdminRpc } from './cli.js'
import {
  broadcastUnreserve,
  describePlan,
  parseUnreserveArgs,
  planUnreserve,
  type UnreservePlan,
} from './unreserve.js'

// Arbitrary valid addresses, same seeds as core's test fixtures (which are
// deliberately not shipped in its build).
const TREASURY = parseAddress('NQ82 24C1 X9HD 6GVL 4JAG AVF6 AT3K FA0Q H3UN')
const PROTOCOL = parseAddress('NQ07 48LK 0DRX 8M65 6NK1 D1PP CYC4 HE99 K857')
const ADMIN = parseAddress('NQ67 6CV4 2J2F AREN 8STJ F608 F3LM KJHS MCDQ')
const MARKETPLACE = parseAddress('NQ28 8H5M 4NB0 CVP7 AY43 HA8R H7V6 MNSB PGN9')
const BOB = parseAddress('NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK')

const config = defineConfig({
  networkId: 24,
  launchHeight: 58_000_000,
  treasury: TREASURY,
  protocol: PROTOCOL,
  admin: ADMIN,
  marketplace: MARKETPLACE,
})

const HEAD = 58_099_950
/** A comfortable day of notice — twice GOVERNANCE_DELAY. */
const EFFECTIVE = HEAD + 2 * CONSTANTS.GOVERNANCE_DELAY
const HASH = 'c0ffee'.repeat(10) + 'c0ff'

interface RecordedCall {
  readonly method: string
  readonly params: readonly unknown[]
}

function fakeRpc(): { rpc: AdminRpc; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const rpc: AdminRpc = {
    call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      calls.push({ method, params })
      switch (method) {
        case 'unlockAccount':
          return Promise.resolve(true as T)
        case 'getBlockNumber':
          return Promise.resolve(HEAD as T)
        case 'sendBasicTransactionWithData':
          return Promise.resolve(HASH as T)
        default:
          return Promise.reject(new Error(`unexpected RPC method ${method}`))
      }
    },
  }
  return { rpc, calls }
}

const release = { name: 'binance', effectiveHeight: EFFECTIVE, recipient: null }
const award = { ...release, recipient: BOB }

describe('planUnreserve', () => {
  it('defaults to release — the transaction goes to PROTOCOL_ADDRESS — and only reads the head', async () => {
    const { rpc, calls } = fakeRpc()
    const plan = await planUnreserve(rpc, config, release)

    const expected = encodeUnreserve(config, { name: 'binance', effectiveHeight: EFFECTIVE })
    expect(plan).toEqual({
      params: release,
      kind: 'release',
      recipient: PROTOCOL,
      data: expected.data,
      value: 1n,
      head: HEAD,
    })
    // Planning is read-only: nothing is unlocked, nothing is sent.
    expect(calls.map((c) => c.method)).toEqual(['getBlockNumber'])
  })

  it('awards to the given recipient with a byte-identical payload', async () => {
    const { rpc } = fakeRpc()
    const plan = await planUnreserve(rpc, config, award)
    expect(plan.kind).toBe('award')
    expect(plan.recipient).toBe(BOB)
    expect(plan.data).toBe(encodeUnreserve(config, release).data)
  })

  it('refuses BURN_ADDRESS before the node hears anything (encodeUnreserve contract)', async () => {
    const { rpc, calls } = fakeRpc()
    await expect(planUnreserve(rpc, config, { ...release, recipient: BURN_ADDRESS })).rejects.toThrow(CodecError)
    expect(calls).toEqual([])
  })

  it('refuses an award to the admin address — a silent self-transaction (§5.3)', async () => {
    const { rpc, calls } = fakeRpc()
    await expect(planUnreserve(rpc, config, { ...release, recipient: ADMIN })).rejects.toThrow(/self-transactions/)
    expect(calls).toEqual([])
  })

  it('rejects an invalid name offline, like every builder (§7.4)', async () => {
    const { rpc, calls } = fakeRpc()
    // `ab-` fails §4.1 rule 4 and is on neither membership route. A
    // well-formed short name (`ab`) is a legal U operand since r18 —
    // reserved by rule, releasable and awardable.
    await expect(planUnreserve(rpc, config, { ...release, name: 'ab-' })).rejects.toThrow(CodecError)
    expect(calls).toEqual([])
  })

  it('plans a U for a short name — reserved by rule, no list entry needed (r18)', async () => {
    const { rpc } = fakeRpc()
    const plan = await planUnreserve(rpc, config, { ...release, name: 'ab' })
    expect(plan.kind).toBe('release')
    expect(plan.params.name).toBe('ab')
  })
})

describe('describePlan', () => {
  const planFor = (effectiveHeight: number, recipient: typeof BOB | null = null): UnreservePlan => ({
    params: { name: 'binance', effectiveHeight, recipient },
    kind: recipient === null ? 'release' : 'award',
    recipient: recipient ?? PROTOCOL,
    data: 'irrelevant',
    value: 1n,
    head: HEAD,
  })

  it('says what a release does, where it goes, and when — absolutely and in hours', () => {
    const lines = describePlan(planFor(HEAD + 2 * CONSTANTS.GOVERNANCE_DELAY)).join('\n')
    expect(lines).toContain('U release: binance')
    expect(lines).toContain('NQ07 48LK 0DRX 8M65 6NK1 D1PP CYC4 HE99 K857')
    expect(lines).toContain('PROTOCOL_ADDRESS')
    expect(lines).toContain(`effective at height ${HEAD + 2 * CONSTANTS.GOVERNANCE_DELAY}`)
    // 86,400 blocks at ~1 block/s is ~24 h.
    expect(lines).toContain('~24.0 h from now')
    expect(lines).not.toContain('WARNING')
  })

  it('names the awardee on an award', () => {
    const lines = describePlan(planFor(HEAD + 2 * CONSTANTS.GOVERNANCE_DELAY, BOB)).join('\n')
    expect(lines).toContain('U award: binance')
    expect(lines).toContain('NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK')
  })

  it('warns when the notice is under GOVERNANCE_DELAY — the reducer would forfeit', () => {
    const lines = describePlan(planFor(HEAD + CONSTANTS.GOVERNANCE_DELAY - 1)).join('\n')
    expect(lines).toContain('INSUFFICIENT_NOTICE')
  })

  it('is blunt about an effective height already in the past', () => {
    const lines = describePlan(planFor(HEAD - 3_600)).join('\n')
    expect(lines).toContain('~1.0 h in the PAST')
    expect(lines).toContain('INSUFFICIENT_NOTICE')
  })
})

describe('broadcastUnreserve', () => {
  it('unlocks by address, then sends with the probed parameter order and the plan head', async () => {
    const { rpc, calls } = fakeRpc()
    const plan = await planUnreserve(rpc, config, release)
    const outcome = await broadcastUnreserve(rpc, config, plan)

    expect(outcome).toEqual({ kind: 'release', recipient: PROTOCOL, validityStartHeight: HEAD, hash: HASH })
    expect(calls.map((c) => c.method)).toEqual(['getBlockNumber', 'unlockAccount', 'sendBasicTransactionWithData'])
    expect(calls[1]?.params).toEqual([ADMIN, null, null])
    // [wallet, recipient, dataHex, value, fee, validityStartHeight] — value
    // as a number, fee 0.
    expect(calls[2]?.params).toEqual([ADMIN, PROTOCOL, plan.data, 1, 0, HEAD])
  })
})

describe('parseUnreserveArgs', () => {
  it('is a dry run unless --send is passed, and omitting the recipient means release', () => {
    expect(parseUnreserveArgs(['binance', '58100000'])).toEqual({
      params: { name: 'binance', effectiveHeight: 58_100_000, recipient: null },
      send: false,
    })
    expect(parseUnreserveArgs(['binance', '58100000', '--send']).send).toBe(true)
    // Flag position does not matter.
    expect(parseUnreserveArgs(['--send', 'binance', '58100000']).send).toBe(true)
  })

  it('a third positional argument is the awardee, parsed and checksummed', () => {
    expect(parseUnreserveArgs(['binance', '58100000', 'NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK'])).toEqual({
      params: { name: 'binance', effectiveHeight: 58_100_000, recipient: BOB },
      send: false,
    })
    expect(() => parseUnreserveArgs(['binance', '58100000', 'not-an-address'])).toThrow(AddressError)
  })

  it('rejects a missing, fractional or extra argument, and any flag that is not --send', () => {
    expect(() => parseUnreserveArgs(['binance'])).toThrow(UsageError)
    expect(() => parseUnreserveArgs(['binance', '1.5'])).toThrow(UsageError)
    expect(() => parseUnreserveArgs(['binance', '58100000', 'NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK', 'extra'])).toThrow(
      UsageError,
    )
    expect(() => parseUnreserveArgs(['binance', '58100000', '--sned'])).toThrow(UsageError)
  })
})
