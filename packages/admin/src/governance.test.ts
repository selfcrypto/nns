import { describe, expect, it } from 'vitest'
import { CONSTANTS, CodecError, LAUNCH_PRICES, defineConfig, encodeGovernance, parseAddress } from '@nns/core'

import { AdminRefusal, UsageError, type AdminRpc } from './cli.js'
import {
  NOTICE_MARGIN,
  PARAMS_LAG_LIMIT,
  broadcastGovernance,
  describeGovernancePlan,
  parseGovernanceArgs,
  planGovernance,
  refusals,
  type GovernanceParams,
  type GovernancePlan,
} from './governance.js'
import type { ActiveParams, ParamsSource } from './params.js'

const TREASURY = parseAddress('NQ82 24C1 X9HD 6GVL 4JAG AVF6 AT3K FA0Q H3UN')
const PROTOCOL = parseAddress('NQ07 48LK 0DRX 8M65 6NK1 D1PP CYC4 HE99 K857')
const ADMIN = parseAddress('NQ67 6CV4 2J2F AREN 8STJ F608 F3LM KJHS MCDQ')
const MARKETPLACE = parseAddress('NQ28 8H5M 4NB0 CVP7 AY43 HA8R H7V6 MNSB PGN9')

const config = defineConfig({
  networkId: 24,
  launchHeight: 58_000_000,
  treasury: TREASURY,
  protocol: PROTOCOL,
  admin: ADMIN,
  marketplace: MARKETPLACE,
})

const HEAD = 58_099_950
/** The minimum this CLI will accept: GOVERNANCE_DELAY plus the mempool margin. */
const EFFECTIVE = HEAD + CONSTANTS.GOVERNANCE_DELAY + NOTICE_MARGIN
const HASH = 'c0ffee'.repeat(10) + 'c0ff'
/** 10 NIM — exactly ADMIN_MIN_BALANCE, so a healthy plan carries no warning. */
const BALANCE = 1_000_000

/** A change inside every §10.6 bound: +25% standard, +25% long, +50 bp. */
const params: GovernanceParams = {
  feeStandard: 500_000_000n,
  feeLong: 50_000_000n,
  commissionBp: 300n,
  effectiveHeight: EFFECTIVE,
}

const active: ActiveParams = {
  prices: LAUNCH_PRICES,
  lastGovernanceHeight: null,
  pending: null,
  height: HEAD - 100,
  url: 'http://api.test/params',
}

interface RecordedCall {
  readonly method: string
  readonly params: readonly unknown[]
}

function fakeRpc(balance = BALANCE): { rpc: AdminRpc; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const rpc: AdminRpc = {
    call<T>(method: string, callParams: readonly unknown[] = []): Promise<T> {
      calls.push({ method, params: callParams })
      switch (method) {
        case 'getBlockNumber':
          return Promise.resolve(HEAD as T)
        case 'getAccountByAddress':
          return Promise.resolve({ address: ADMIN, balance, type: 'basic' } as T)
        case 'unlockAccount':
          return Promise.resolve(true as T)
        case 'sendBasicTransactionWithData':
          return Promise.resolve(HASH as T)
        default:
          return Promise.reject(new Error(`unexpected RPC method ${method}`))
      }
    },
  }
  return { rpc, calls }
}

const source = (overrides: Partial<ActiveParams> = {}): ParamsSource => ({
  fetchParams: () => Promise.resolve({ ...active, ...overrides }),
})

async function plan(
  overrides: Partial<GovernanceParams> = {},
  paramsOverrides: Partial<ActiveParams> = {},
  balance = BALANCE,
): Promise<GovernancePlan> {
  const { rpc } = fakeRpc(balance)
  return await planGovernance(rpc, source(paramsOverrides), config, { ...params, ...overrides })
}

const messages = (built: GovernancePlan): string => built.checks.map((check) => check.message).join('\n')

describe('planGovernance', () => {
  it('builds the message core builds, and reads only the head, the parameters and the balance', async () => {
    const { rpc, calls } = fakeRpc()
    const built = await planGovernance(rpc, source(), config, params)

    const expected = encodeGovernance(config, params)
    expect(built.data).toBe(expected.data)
    expect(built.recipient).toBe(PROTOCOL)
    expect(built.sender).toBe(ADMIN)
    expect(built.value).toBe(CONSTANTS.DUST_VALUE)
    expect(built.cost).toBe(CONSTANTS.DUST_VALUE)
    expect(built.head).toBe(HEAD)
    expect(built.balance).toBe(BigInt(BALANCE))
    expect(built.active).toEqual(active)
    // Planning is read-only: nothing is unlocked, nothing is sent.
    expect(calls.map((call) => call.method)).toEqual(['getBlockNumber', 'getAccountByAddress'])
    expect(calls[1]?.params).toEqual([ADMIN])
  })

  it('a plan inside every bound carries no check at all — --send adds only the broadcast', async () => {
    expect(await plan().then((built) => built.checks)).toEqual([])
  })

  it('refuses offline, before the node hears anything, whatever the builder refuses', async () => {
    const { rpc, calls } = fakeRpc()
    await expect(planGovernance(rpc, source(), config, { ...params, feeStandard: -1n })).rejects.toThrow(CodecError)
    expect(calls).toEqual([])
  })
})

describe('§10.6 bounds — core’s rule, checked before signing', () => {
  it('refuses a price moving more than PRICE_MAX_FACTOR, and says what the window was', async () => {
    const built = await plan({ feeStandard: LAUNCH_PRICES.feeStandard * 3n })
    expect(refusals(built)).toHaveLength(1)
    expect(messages(built)).toContain('PRICE_MAX_FACTOR')
    expect(messages(built)).toContain('GOVERNANCE_BOUND_VIOLATED')
    expect(messages(built)).toContain('cannot be retracted')
  })

  it('refuses fee_long above fee_standard', async () => {
    const built = await plan({ feeLong: params.feeStandard + 1n })
    expect(messages(built)).toContain('ORDERING')
  })

  it('refuses a commission above COMMISSION_CEILING, and a step above COMMISSION_MAX_STEP', async () => {
    expect(messages(await plan({ commissionBp: CONSTANTS.COMMISSION_CEILING + 1n }))).toContain('COMMISSION_CEILING')
    expect(
      messages(await plan({ commissionBp: LAUNCH_PRICES.commissionBp + CONSTANTS.COMMISSION_MAX_STEP + 1n })),
    ).toContain('COMMISSION_MAX_STEP')
  })

  it('refuses a price below PRICE_FLOOR — the band, not the factor', async () => {
    // Reachable in one step only from a price already near the floor.
    const near = { feeStandard: CONSTANTS.PRICE_FLOOR, feeLong: CONSTANTS.PRICE_FLOOR, commissionBp: 250n }
    const built = await plan({ feeStandard: 0n, feeLong: 0n }, { prices: near })
    expect(messages(built)).toContain('PRICE_BAND')
  })

  it('refuses a P inside PRICE_MIN_INTERVAL of the last accepted one, and says how long to wait', async () => {
    const built = await plan({}, { lastGovernanceHeight: HEAD - 100 })
    expect(messages(built)).toContain('TOO_SOON')
    expect(messages(built)).toContain(`wait ${CONSTANTS.PRICE_MIN_INTERVAL - 100} more blocks`)
  })

  it('accepts one exactly PRICE_MIN_INTERVAL later — inclusion is at or after this head', async () => {
    const built = await plan({}, { lastGovernanceHeight: HEAD - CONSTANTS.PRICE_MIN_INTERVAL })
    expect(built.checks).toEqual([])
  })
})

describe('notice (§6 P) — the bound that cannot be checked exactly', () => {
  it('refuses a certain forfeit: under GOVERNANCE_DELAY from head', async () => {
    const built = await plan({ effectiveHeight: HEAD + CONSTANTS.GOVERNANCE_DELAY - 1 })
    expect(messages(built)).toContain('INSUFFICIENT_NOTICE')
    expect(messages(built)).toContain('even if it is mined in the next block')
  })

  it('refuses the bare minimum too, and names the height that carries the margin', async () => {
    const built = await plan({ effectiveHeight: HEAD + CONSTANTS.GOVERNANCE_DELAY })
    expect(refusals(built)).toHaveLength(1)
    expect(messages(built)).toContain('measured from the block this lands in')
    expect(messages(built)).toContain(String(HEAD + CONSTANTS.GOVERNANCE_DELAY + NOTICE_MARGIN))
  })

  it('accepts GOVERNANCE_DELAY plus the margin', async () => {
    expect(await plan({ effectiveHeight: EFFECTIVE }).then((built) => built.checks)).toEqual([])
  })
})

describe('§11.5 balance precheck', () => {
  it('refuses a sender that cannot cover value + fee — the failure is silence, not an error', async () => {
    const built = await plan({}, {}, 0)
    expect(refusals(built)).toHaveLength(1)
    expect(messages(built)).toContain('§11.5')
    expect(messages(built)).toContain('never be mined')
  })

  it('warns — and still sends — below the operational floor', async () => {
    const built = await plan({}, {}, 5)
    expect(refusals(built)).toEqual([])
    expect(built.checks.map((check) => check.severity)).toEqual(['warn'])
    expect(messages(built)).toContain('top it up')
  })

  it('rejects a balance the node did not answer in whole luna', async () => {
    const rpc: AdminRpc = {
      call<T>(method: string): Promise<T> {
        if (method === 'getBlockNumber') return Promise.resolve(HEAD as T)
        return Promise.resolve({ balance: '1000' } as T)
      },
    }
    await expect(planGovernance(rpc, source(), config, params)).rejects.toThrow(/whole number of luna/)
  })
})

describe('the source of the relative bounds', () => {
  it('warns when the API is far behind the node — a P accepted since would not be reflected', async () => {
    const built = await plan({}, { height: HEAD - PARAMS_LAG_LIMIT - 1 })
    expect(built.checks.map((check) => check.severity)).toEqual(['warn'])
    expect(messages(built)).toContain('http://api.test/params')
    expect(messages(built)).toContain('blocks behind the node')
  })

  it('does not warn about the ordinary finality lag', async () => {
    expect(await plan({}, { height: HEAD - PARAMS_LAG_LIMIT }).then((built) => built.checks)).toEqual([])
  })
})

describe('describeGovernancePlan', () => {
  it('prints every parameter as a change, the height both ways, and what the bounds were checked against', async () => {
    const lines = describeGovernancePlan(await plan()).join('\n')
    expect(lines).toContain('P governance:')
    expect(lines).toContain('400000000 luna (4000 NIM) → 500000000 luna (5000 NIM)')
    expect(lines).toContain('250 bp → 300 bp')
    expect(lines).toContain(`effective at height ${EFFECTIVE} — head is ${HEAD}`)
    expect(lines).toContain('~13.0 h from now')
    expect(lines).toContain('NQ07 48LK 0DRX 8M65 6NK1 D1PP CYC4 HE99 K857')
    expect(lines).toContain('PROTOCOL_ADDRESS')
    expect(lines).toContain('ADMIN_ADDRESS), balance 1000000 luna (10 NIM)')
    expect(lines).toContain(`http://api.test/params at height ${HEAD - 100} (100 blocks behind head)`)
    expect(lines).toContain('last P      none accepted since launch')
    expect(lines).not.toContain('WARNING')
    expect(lines).not.toContain('REFUSED')
  })

  it('says "unchanged" rather than showing a change that is not one', async () => {
    const lines = describeGovernancePlan(await plan({ commissionBp: LAUNCH_PRICES.commissionBp })).join('\n')
    expect(lines).toContain('250 bp (unchanged)')
  })

  it('names the last P and any pending change — the two things a P has to be planned around', async () => {
    const built = await plan(
      {},
      {
        lastGovernanceHeight: HEAD - CONSTANTS.PRICE_MIN_INTERVAL,
        pending: { prices: LAUNCH_PRICES, effectiveHeight: HEAD + 1_000 },
      },
    )
    const lines = describeGovernancePlan(built).join('\n')
    expect(lines).toContain(`last P      height ${HEAD - CONSTANTS.PRICE_MIN_INTERVAL}`)
    expect(lines).toContain(`pending`)
    expect(lines).toContain(`at height ${HEAD + 1_000}`)
  })

  it('prints each failed check, marked as the refusal it is', async () => {
    const lines = describeGovernancePlan(await plan({ effectiveHeight: HEAD }, {}, 0)).join('\n')
    expect(lines).toContain('REFUSED: §6 P notice')
    expect(lines).toContain('REFUSED: §11.5')
    expect(lines).toContain('~0.0 h from now')
  })
})

describe('broadcastGovernance', () => {
  it('unlocks by address, then sends with the probed parameter order and the plan head', async () => {
    const { rpc, calls } = fakeRpc()
    const built = await planGovernance(rpc, source(), config, params)
    const outcome = await broadcastGovernance(rpc, config, built)

    expect(outcome).toEqual({ validityStartHeight: HEAD, hash: HASH })
    expect(calls.map((call) => call.method)).toEqual([
      'getBlockNumber',
      'getAccountByAddress',
      'unlockAccount',
      'sendBasicTransactionWithData',
    ])
    expect(calls[2]?.params).toEqual([ADMIN, null, null])
    // [wallet, recipient, dataHex, value, fee, validityStartHeight] — value as
    // a number, fee 0.
    expect(calls[3]?.params).toEqual([ADMIN, PROTOCOL, built.data, 1, 0, HEAD])
  })

  it('refuses a plan carrying a refusal, without unlocking anything', async () => {
    const { rpc, calls } = fakeRpc(0)
    const built = await planGovernance(rpc, source(), config, { ...params, effectiveHeight: HEAD })
    await expect(broadcastGovernance(rpc, config, built)).rejects.toThrow(AdminRefusal)
    expect(calls.map((call) => call.method)).toEqual(['getBlockNumber', 'getAccountByAddress'])
  })
})

describe('parseGovernanceArgs', () => {
  it('is a dry run unless --send is passed, and takes luna and basis points', () => {
    expect(parseGovernanceArgs(['500000000', '50000000', '300', '58150000'])).toEqual({
      params: { feeStandard: 500_000_000n, feeLong: 50_000_000n, commissionBp: 300n, effectiveHeight: 58_150_000 },
      send: false,
    })
    expect(parseGovernanceArgs(['500000000', '50000000', '300', '58150000', '--send']).send).toBe(true)
    // Flag position does not matter.
    expect(parseGovernanceArgs(['--send', '500000000', '50000000', '300', '58150000']).send).toBe(true)
  })

  it('rejects a missing, fractional or extra argument, and any flag that is not --send', () => {
    expect(() => parseGovernanceArgs(['500000000', '50000000', '300'])).toThrow(UsageError)
    expect(() => parseGovernanceArgs(['500000000', '50000000', '300', '58150000', 'extra'])).toThrow(UsageError)
    expect(() => parseGovernanceArgs(['5000.5', '50000000', '300', '58150000'])).toThrow(/luna/)
    expect(() => parseGovernanceArgs(['500000000', '50000000', '3.5', '58150000'])).toThrow(UsageError)
    expect(() => parseGovernanceArgs(['500000000', '50000000', '300', '58150000.5'])).toThrow(UsageError)
    expect(() => parseGovernanceArgs(['500000000', '50000000', '300', '58150000', '--sned'])).toThrow(UsageError)
  })
})
