import { describe, expect, it } from 'vitest'
import { AddressError, BURN_ADDRESS, CodecError, CONSTANTS, defineConfig, encodeUnreserve, parseAddress } from '@nns/core'

import { AdminRefusal, UsageError, type AdminRpc } from './cli.js'
import type { NameAvailability, ReservationSource } from './reservation.js'
import {
  broadcastUnreserve,
  describePlan,
  parseUnreserveArgs,
  planUnreserve,
  unreserveRefusals,
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

/** 10 NIM — exactly ADMIN_MIN_BALANCE, so a healthy plan carries no warning. */
function fakeRpc(balance = 1_000_000): { rpc: AdminRpc; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const rpc: AdminRpc = {
    call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      calls.push({ method, params })
      switch (method) {
        case 'unlockAccount':
          return Promise.resolve(true as T)
        case 'getBlockNumber':
          return Promise.resolve(HEAD as T)
        case 'getAccountByAddress':
          return Promise.resolve({ balance } as T)
        case 'sendBasicTransactionWithData':
          return Promise.resolve(HASH as T)
        default:
          return Promise.reject(new Error(`unexpected RPC method ${method}`))
      }
    },
  }
  return { rpc, calls }
}

const API = 'https://api.example/available/binance'

/**
 * `/available/{name}` as a `U` needs it. The default is the one state in
 * which a `U` lands: on the list, not yet released by a fired `U`.
 */
function fakeReservation(overrides: Partial<NameAvailability> = {}): ReservationSource {
  return {
    fetchAvailability(name: string): Promise<NameAvailability> {
      return Promise.resolve(
        Object.freeze({
          name,
          available: false,
          reason: 'RESERVED',
          status: null,
          expiry: null,
          height: HEAD,
          url: API,
          ...overrides,
        }),
      )
    },
  }
}

/** What the API said about `nimiq` on 2026-08-21, the day the U forfeited. */
const TAKEN: Partial<NameAvailability> = {
  available: false,
  reason: 'TAKEN',
  status: 'REGISTERED',
  expiry: 59_765_881,
}

const RESERVED: NameAvailability = Object.freeze({
  name: 'binance',
  available: false,
  reason: 'RESERVED',
  status: null,
  expiry: null,
  height: HEAD,
  url: API,
})

const release = { name: 'binance', recipient: null }
const award = { ...release, recipient: BOB }

describe('planUnreserve', () => {
  it('defaults to release — the transaction goes to PROTOCOL_ADDRESS — and reads only head and balance', async () => {
    const { rpc, calls } = fakeRpc()
    const plan = await planUnreserve(rpc, fakeReservation(), config, release)

    const expected = encodeUnreserve({ name: 'binance' })
    expect(plan).toEqual({
      params: release,
      kind: 'release',
      recipient: PROTOCOL,
      data: expected.data,
      value: 1n,
      head: HEAD,
      balance: 1_000_000n,
      availability: RESERVED,
      // §11.5 and the reservation are the two checks a `U` carries, and a
      // funded sender releasing a still-reserved name passes both silently.
      checks: [],
    })
    // Planning is read-only: nothing is unlocked, nothing is sent.
    expect(calls.map((c) => c.method)).toEqual(['getBlockNumber', 'getAccountByAddress'])
  })

  it('refuses an unfunded sender — the silent-drop route §11.5 exists for', async () => {
    // Balance 0: the RPC would accept the transaction, return a hash, and it
    // would never be mined. The plan must carry a refusal, and broadcast must
    // re-check it rather than trust the caller.
    const { rpc, calls } = fakeRpc(0)
    const plan = await planUnreserve(rpc, fakeReservation(), config, release)
    expect(plan.checks).toHaveLength(1)
    expect(plan.checks[0]).toMatchObject({ severity: 'refuse' })
    expect(plan.checks[0]?.message).toContain('§11.5')
    await expect(broadcastUnreserve(rpc, config, plan)).rejects.toThrow(AdminRefusal)
    // The refusal reaches the node for nothing beyond the plan's own reads.
    expect(calls.map((c) => c.method)).toEqual(['getBlockNumber', 'getAccountByAddress'])
  })

  it('warns under ADMIN_MIN_BALANCE without blocking the send', async () => {
    // 5 NIM: funded for dust, but §11.5 rule 2 says alerting at zero alerts
    // after the failure.
    const { rpc } = fakeRpc(500_000)
    const plan = await planUnreserve(rpc, fakeReservation(), config, release)
    expect(plan.checks).toHaveLength(1)
    expect(plan.checks[0]).toMatchObject({ severity: 'warn' })
    await expect(broadcastUnreserve(rpc, config, plan)).resolves.toMatchObject({ hash: HASH })
  })

  it('awards to the given recipient with a byte-identical payload', async () => {
    const { rpc } = fakeRpc()
    const plan = await planUnreserve(rpc, fakeReservation(), config, award)
    expect(plan.kind).toBe('award')
    expect(plan.recipient).toBe(BOB)
    expect(plan.data).toBe(encodeUnreserve(release).data)
  })

  it('builds the r22 one-field payload, with no height anywhere in it', async () => {
    const { rpc } = fakeRpc()
    const plan = await planUnreserve(rpc, fakeReservation(), config, release)
    expect(Buffer.from(plan.data, 'hex').toString('ascii')).toBe('NNS1Ubinance')
  })

  it('refuses BURN_ADDRESS before the node hears anything (encodeUnreserve contract)', async () => {
    const { rpc, calls } = fakeRpc()
    await expect(planUnreserve(rpc, fakeReservation(), config, { ...release, recipient: BURN_ADDRESS })).rejects.toThrow(CodecError)
    expect(calls).toEqual([])
  })

  it('an awardee spelled as PROTOCOL_ADDRESS is a release — the plan reads the built recipient, not argv', async () => {
    const { rpc } = fakeRpc()
    const plan = await planUnreserve(rpc, fakeReservation(), config, { ...release, recipient: PROTOCOL })
    // Byte-identical to the release: the reducer sees the recipient, nothing else.
    expect(plan.data).toBe(encodeUnreserve({ name: 'binance' }).data)
    expect(plan.recipient).toBe(PROTOCOL)
    expect(plan.kind).toBe('release')
    const lines = describePlan(plan).join('\n')
    expect(lines).toContain('U release: binance')
    expect(lines).not.toContain('award term')
  })

  it('refuses an award to the admin address — a silent self-transaction (§5.3)', async () => {
    const { rpc, calls } = fakeRpc()
    await expect(planUnreserve(rpc, fakeReservation(), config, { ...release, recipient: ADMIN })).rejects.toThrow(/self-transactions/)
    expect(calls).toEqual([])
  })

  it('rejects an invalid name offline, like every builder (§7.4)', async () => {
    const { rpc, calls } = fakeRpc()
    // `ab-` fails §4.1 rule 4 and is on neither membership route. A
    // well-formed short name (`ab`) is a legal U operand since r18 —
    // reserved by rule, releasable and awardable.
    await expect(planUnreserve(rpc, fakeReservation(), config, { ...release, name: 'ab-' })).rejects.toThrow(CodecError)
    expect(calls).toEqual([])
  })

  // ── The reservation rows (2026-08-21) ────────────────────────────────────
  // `u nimiq` printed a clean plan and forfeited NAME_NOT_RESERVED in block
  // 59478946. The message cannot answer `isReserved(state, name)` about
  // itself; these are the checks that read it.

  it('refuses a name that is registered to somebody — the nimiq case, measured', async () => {
    const { rpc, calls } = fakeRpc()
    const plan = await planUnreserve(rpc, fakeReservation(TAKEN), config, release)
    const refusals = unreserveRefusals(plan)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.message).toContain('no longer RESERVED')
    expect(refusals[0]?.message).toContain('REGISTERED to somebody')
    expect(refusals[0]?.message).toContain('NAME_NOT_RESERVED')
    // And it never reaches the node with it.
    await expect(broadcastUnreserve(rpc, config, plan)).rejects.toThrow(AdminRefusal)
    expect(calls.map((c) => c.method)).toEqual(['getBlockNumber', 'getAccountByAddress'])
  })

  it('refuses a name in GRACE — renewable, hence still taken', async () => {
    const { rpc } = fakeRpc()
    const plan = await planUnreserve(rpc, fakeReservation({ ...TAKEN, status: 'GRACE' }), config, release)
    expect(unreserveRefusals(plan)[0]?.message).toContain('GRACE')
  })

  it('refuses a name a fired U already released — AVAILABLE, nothing left to release', async () => {
    const { rpc } = fakeRpc()
    const plan = await planUnreserve(rpc, fakeReservation({ available: true, reason: null }), config, release)
    expect(unreserveRefusals(plan)[0]?.message).toContain('nothing left to release')
  })

  it('refuses a name that was never reserved, without needing the chain state', async () => {
    // `probe-name` is neither on RESERVED_NAMES nor short-reserved, so no
    // state the chain could be in makes this U land — and the refusal says
    // so rather than reading as "try again later".
    const { rpc } = fakeRpc()
    const plan = await planUnreserve(rpc, fakeReservation({ available: true, reason: null }), config, {
      ...release,
      name: 'probe-name',
    })
    const refusals = unreserveRefusals(plan)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.message).toContain('whatever the chain state is')
  })

  it('carries exactly one reservation refusal, never both halves at once', async () => {
    // A name off the list is also not RESERVED at the API, and two refusals
    // for one cause reads as two problems.
    const { rpc } = fakeRpc()
    const plan = await planUnreserve(rpc, fakeReservation(TAKEN), config, { ...release, name: 'probe-name' })
    expect(unreserveRefusals(plan)).toHaveLength(1)
  })

  it('warns, without refusing, when the reservation was read far behind the head', async () => {
    const { rpc } = fakeRpc()
    const plan = await planUnreserve(rpc, fakeReservation({ height: HEAD - 5_000 }), config, release)
    expect(unreserveRefusals(plan)).toHaveLength(0)
    expect(plan.checks).toHaveLength(1)
    expect(plan.checks[0]).toMatchObject({ severity: 'warn' })
    expect(plan.checks[0]?.message).toContain('5000 blocks behind')
  })

  it('plans a U for a short name — reserved by rule, no list entry needed (r18)', async () => {
    const { rpc } = fakeRpc()
    const plan = await planUnreserve(rpc, fakeReservation(), config, { ...release, name: 'ab' })
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
    balance: 1_000_000n,
    availability: { ...RESERVED, name },
    checks: [],
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

  it('prints the state it checked and how stale that reading was', () => {
    // The row that decides whether the message lands at all, and the one a
    // plan built from the message alone could not show.
    const lines = describePlan(planFor()).join('\n')
    expect(lines).toContain('state     RESERVED')
    expect(lines).toContain(API)
    expect(lines).toContain('0 blocks behind head')
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
    const plan = await planUnreserve(rpc, fakeReservation(), config, release)
    const outcome = await broadcastUnreserve(rpc, config, plan)

    expect(outcome).toEqual({ kind: 'release', recipient: PROTOCOL, validityStartHeight: HEAD, hash: HASH })
    expect(calls.map((c) => c.method)).toEqual([
      'getBlockNumber',
      'getAccountByAddress',
      'unlockAccount',
      'sendBasicTransactionWithData',
    ])
    expect(calls[2]?.params).toEqual([ADMIN, null, null])
    // [wallet, recipient, dataHex, value, fee, validityStartHeight] — value
    // as a number, fee 0.
    expect(calls[3]?.params).toEqual([ADMIN, PROTOCOL, plan.data, 1, 0, HEAD])
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
