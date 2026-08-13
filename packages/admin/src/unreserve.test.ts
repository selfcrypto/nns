import { describe, expect, it } from 'vitest'
import { AddressError, BURN_ADDRESS, CodecError, defineConfig, encodeUnreserve, parseAddress } from '@nns/core'

import { UsageError, parseUnreserveArgs, sendUnreserve, type AdminRpc } from './unreserve.js'

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
  listingFee: 0n,
  reservedNames: ['binance'],
})

const HEAD = 58_099_950
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

describe('sendUnreserve', () => {
  it('defaults to release: the transaction goes to PROTOCOL_ADDRESS', async () => {
    const { rpc, calls } = fakeRpc()
    const outcome = await sendUnreserve(rpc, config, {
      name: 'binance',
      effectiveHeight: 58_100_000,
      recipient: null,
    })

    expect(outcome).toEqual({ kind: 'release', recipient: PROTOCOL, validityStartHeight: HEAD, hash: HASH })
    expect(calls.map((c) => c.method)).toEqual(['unlockAccount', 'getBlockNumber', 'sendBasicTransactionWithData'])
    expect(calls[0]?.params).toEqual([ADMIN, null, null])

    const expected = encodeUnreserve(config, { name: 'binance', effectiveHeight: 58_100_000 })
    // [wallet, recipient, dataHex, value, fee, validityStartHeight] — the
    // probed parameter order, value as a number, fee 0.
    expect(calls[2]?.params).toEqual([ADMIN, PROTOCOL, expected.data, 1, 0, HEAD])
  })

  it('awards to the given recipient with a byte-identical payload', async () => {
    const { rpc, calls } = fakeRpc()
    const outcome = await sendUnreserve(rpc, config, {
      name: 'binance',
      effectiveHeight: 58_100_000,
      recipient: BOB,
    })

    expect(outcome.kind).toBe('award')
    expect(outcome.recipient).toBe(BOB)
    const release = encodeUnreserve(config, { name: 'binance', effectiveHeight: 58_100_000 })
    expect(calls[2]?.params).toEqual([ADMIN, BOB, release.data, 1, 0, HEAD])
  })

  it('refuses BURN_ADDRESS before the node hears anything (encodeUnreserve contract)', async () => {
    const { rpc, calls } = fakeRpc()
    await expect(
      sendUnreserve(rpc, config, { name: 'binance', effectiveHeight: 58_100_000, recipient: BURN_ADDRESS }),
    ).rejects.toThrow(CodecError)
    expect(calls).toEqual([])
  })

  it('refuses an award to the admin address — a silent self-transaction (§5.3)', async () => {
    const { rpc, calls } = fakeRpc()
    await expect(
      sendUnreserve(rpc, config, { name: 'binance', effectiveHeight: 58_100_000, recipient: ADMIN }),
    ).rejects.toThrow(/self-transactions/)
    expect(calls).toEqual([])
  })

  it('rejects an invalid name offline, like every builder (§7.4)', async () => {
    const { rpc, calls } = fakeRpc()
    await expect(
      sendUnreserve(rpc, config, { name: 'ab', effectiveHeight: 58_100_000, recipient: null }),
    ).rejects.toThrow(CodecError)
    expect(calls).toEqual([])
  })
})

describe('parseUnreserveArgs', () => {
  it('omitting the recipient means release', () => {
    expect(parseUnreserveArgs(['binance', '58100000'])).toEqual({
      name: 'binance',
      effectiveHeight: 58_100_000,
      recipient: null,
    })
  })

  it('a third argument is the awardee, parsed and checksummed', () => {
    expect(parseUnreserveArgs(['binance', '58100000', 'NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK'])).toEqual({
      name: 'binance',
      effectiveHeight: 58_100_000,
      recipient: BOB,
    })
    expect(() => parseUnreserveArgs(['binance', '58100000', 'not-an-address'])).toThrow(AddressError)
  })

  it('rejects a missing, fractional or extra argument', () => {
    expect(() => parseUnreserveArgs(['binance'])).toThrow(UsageError)
    expect(() => parseUnreserveArgs(['binance', '1.5'])).toThrow(UsageError)
    expect(() => parseUnreserveArgs(['binance', '58100000', 'NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK', 'extra'])).toThrow(
      UsageError,
    )
  })
})
