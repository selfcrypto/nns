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
const PROTOCOL = CONSTANTS.PROTOCOL_ADDRESS
const ADMIN = CONSTANTS.ADMIN_ADDRESS
const BOB = parseAddress('NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK')

const config = defineConfig({ networkId: 24 })

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

const release = { name: 'binance', recipient: null }
const award = { ...release, recipient: BOB }

describe('planUnreserve', () => {
  it('defaults to release — the transaction goes to PROTOCOL_ADDRESS — and only reads the head', async () => {
    const { rpc, calls } = fakeRpc()
    const plan = await planUnreserve(rpc, config, release)

    const expected = encodeUnreserve({ name: 'binance' })
    expect(plan).toEqual({
      params: release,
      kind: 'release',
      recipient: PROTOCOL,
      data: expected.data,
      value: 1n,
      head: HEAD,
    })
    // No `checks` field: r22 removed the notice, which was the only bound this
    // command could check from here (§6 `U`).
    expect(plan).not.toHaveProperty('checks')
    // Planning is read-only: nothing is unlocked, nothing is sent.
    expect(calls.map((c) => c.method)).toEqual(['getBlockNumber'])
  })

  it('awards to the given recipient with a byte-identical payload', async () => {
    const { rpc } = fakeRpc()
    const plan = await planUnreserve(rpc, config, award)
    expect(plan.kind).toBe('award')
    expect(plan.recipient).toBe(BOB)
    expect(plan.data).toBe(encodeUnreserve(release).data)
  })

  it('builds the r22 one-field payload, with no height anywhere in it', async () => {
    const { rpc } = fakeRpc()
    const plan = await planUnreserve(rpc, config, release)
    expect(Buffer.from(plan.data, 'hex').toString('ascii')).toBe('NNS1Ubinance')
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
  const planFor = (recipient: typeof BOB | null = null, name = 'binance'): UnreservePlan => ({
    params: { name, recipient },
    kind: recipient === null ? 'release' : 'award',
    recipient: recipient ?? PROTOCOL,
    data: encodeUnreserve({ name, recipient }).data,
    value: 1n,
    head: HEAD,
  })

  it('says what a release does, where it goes, and that it binds on landing', () => {
    const lines = describePlan(planFor()).join('\n')
    expect(lines).toContain('U release: binance')
    expect(lines).toContain('NQ38 NKD4 7ALG YRDQ DXL8 PARE 7JRS JGJD MAU8')
    expect(lines).toContain('PROTOCOL_ADDRESS')
    expect(lines).toContain('effective on landing')
    expect(lines).toContain('no notice window and nothing to cancel')
  })

  it('names the awardee on an award', () => {
    const lines = describePlan(planFor(BOB)).join('\n')
    expect(lines).toContain('U award: binance')
    expect(lines).toContain('NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK')
  })

  it('mentions no effective height, no notice and no margin at all', () => {
    // The old plan printed four numbers about timing; three of them described
    // a window that no longer exists. Leaving one behind would tell an
    // operator they had time they do not have.
    const lines = describePlan(planFor()).join('\n')
    for (const stale of ['effective at height', 'earliest usable', 'GOVERNANCE_DELAY', 'landing margin']) {
      expect(lines).not.toContain(stale)
    }
  })

  it('decodes the payload it built rather than echoing the argument back', () => {
    // With no notice window, this readback is the only thing between a typo
    // and a permanently released name — so it must come from the bytes.
    const lines = describePlan(planFor(null, 'nimiq')).join('\n')
    expect(lines).toContain('4e4e5331556e696d6971') // NNS1Unimiq
    expect(lines).toContain('decoded: name "nimiq", no other field')
  })

  it('says outright that the message cannot be recalled', () => {
    expect(describePlan(planFor()).join('\n')).toContain('IRREVERSIBLE')
  })

  it('states an award’s term from the landing block, half-open per §7.3', () => {
    const lines = describePlan(planFor(BOB)).join('\n')
    expect(lines).toContain(String(CONSTANTS.TERM_LENGTH))
    expect(lines).toContain(String(HEAD + CONSTANTS.TERM_LENGTH))
  })

  it('throws rather than print a plan whose payload is not a U', () => {
    // The readback is the protection, so it must fail loudly if it cannot be
    // performed instead of falling back to `params`.
    expect(() => describePlan({ ...planFor(), data: '4e4e533146' })).toThrow(/does not parse back as one/)
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
    expect(parseUnreserveArgs(['binance'])).toEqual({
      params: { name: 'binance', recipient: null },
      send: false,
    })
    expect(parseUnreserveArgs(['binance', '--send']).send).toBe(true)
    // Flag position does not matter.
    expect(parseUnreserveArgs(['--send', 'binance']).send).toBe(true)
  })

  it('a second positional argument is the awardee, parsed and checksummed', () => {
    expect(parseUnreserveArgs(['binance', 'NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK'])).toEqual({
      params: { name: 'binance', recipient: BOB },
      send: false,
    })
    expect(() => parseUnreserveArgs(['binance', 'not-an-address'])).toThrow(AddressError)
  })

  it('names the r21 habit rather than reading a height as an address', () => {
    // `u binance 58100000` was the whole command through r21. Left to
    // `parseAddress` it would fail as a malformed address, which says nothing
    // about why the argument is gone.
    expect(() => parseUnreserveArgs(['binance', '58100000'])).toThrow(UsageError)
    expect(() => parseUnreserveArgs(['binance', '58100000'])).toThrow(/no longer takes an effective height/)
  })

  it('rejects a missing or extra argument, and any flag that is not --send', () => {
    expect(() => parseUnreserveArgs([])).toThrow(UsageError)
    expect(() =>
      parseUnreserveArgs(['binance', 'NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK', 'extra']),
    ).toThrow(UsageError)
    expect(() => parseUnreserveArgs(['binance', '--sned'])).toThrow(UsageError)
  })
})
