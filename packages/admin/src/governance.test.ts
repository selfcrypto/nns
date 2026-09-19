import { describe, expect, it } from 'vitest'
import { CONSTANTS, CodecError, LAUNCH_PRICES, encodeGovernance, parseAddress } from '@nimiqnames/core'

import { AdminRefusal, blockingChecks, broadcast, NOTICE_MARGIN, UsageError, type AdminRpc } from './cli.js'
import {
  LARGE_MOVE_FACTOR,
  PARAMS_LAG_LIMIT,
  describeGovernancePlan,
  parseGovernanceArgs,
  planGovernance,
  type GovernanceParams,
  type GovernancePlan,
} from './governance.js'
import type { ActiveParams, ParamsSource } from './params.js'

const TREASURY = CONSTANTS.TREASURY_ADDRESS
const PROTOCOL = CONSTANTS.PROTOCOL_ADDRESS
const ADMIN = CONSTANTS.ADMIN_ADDRESS
const MARKETPLACE = CONSTANTS.MARKETPLACE_ADDRESS


const HEAD = 58_099_950
/** The minimum this CLI will accept: GOVERNANCE_DELAY plus the mempool margin. */
const EFFECTIVE = HEAD + CONSTANTS.GOVERNANCE_DELAY + NOTICE_MARGIN
const HASH = 'c0ffee'.repeat(10) + 'c0ff'
/** 10 NIM — well above ADMIN_MIN_BALANCE, so a healthy plan carries no warning. */
const BALANCE = 1_000_000

/** A change inside every §10.6 bound: +25% on the base fee, +50 bp. */
const params: GovernanceParams = {
  feeBase: 50_000_000n,
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
  return await planGovernance(rpc, source(paramsOverrides), { ...params, ...overrides })
}

const messages = (built: GovernancePlan): string => built.checks.map((check) => check.message).join('\n')

describe('planGovernance', () => {
  it('builds the message core builds, and reads only the head, the parameters and the balance', async () => {
    const { rpc, calls } = fakeRpc()
    const built = await planGovernance(rpc, source(), params)

    const expected = encodeGovernance(params)
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
    await expect(planGovernance(rpc, source(), { ...params, feeBase: -1n })).rejects.toThrow(CodecError)
    expect(calls).toEqual([])
  })
})

describe('§10.6 bounds — core’s rule, checked before signing', () => {
  it('refuses a price above PRICE_CEILING, and says the message cannot be retracted', async () => {
    const built = await plan({ feeBase: CONSTANTS.PRICE_CEILING + 1n })
    expect(blockingChecks(built.checks)).toHaveLength(1)
    expect(messages(built)).toContain('PRICE_BAND')
    expect(messages(built)).toContain('GOVERNANCE_BOUND_VIOLATED')
    expect(messages(built)).toContain('cannot be retracted')
  })

  it('warns — and does not refuse — a move larger than LARGE_MOVE_FACTOR', async () => {
    // §10.6 has no rate limit, so a 3× move is a legal P. The only thing left
    // between a misplaced decimal and a repriced registry is this warning.
    const built = await plan({ feeBase: LAUNCH_PRICES.feeBase * 3n })
    expect(blockingChecks(built.checks)).toEqual([])
    expect(messages(built)).toContain(`more than ${LARGE_MOVE_FACTOR}×`)
    expect(messages(built)).toContain('Check the decimal point')
  })

  it('says nothing about a move inside the factor', async () => {
    expect(await plan({ feeBase: LAUNCH_PRICES.feeBase * 2n }).then((b) => b.checks)).toEqual([])
  })

  it('refuses a commission above COMMISSION_CEILING, and a step above COMMISSION_MAX_STEP', async () => {
    expect(messages(await plan({ commissionBp: CONSTANTS.COMMISSION_CEILING + 1n }))).toContain('COMMISSION_CEILING')
    expect(
      messages(await plan({ commissionBp: LAUNCH_PRICES.commissionBp + CONSTANTS.COMMISSION_MAX_STEP + 1n })),
    ).toContain('COMMISSION_MAX_STEP')
  })

  it('refuses a price below PRICE_FLOOR — the band, not the factor', async () => {
    // Reachable in one step only from a price already near the floor.
    const near = { feeBase: CONSTANTS.PRICE_FLOOR, commissionBp: 250n }
    const built = await plan({ feeBase: 0n }, { prices: near })
    expect(messages(built)).toContain('PRICE_BAND')
  })

  it('accepts a P one block after the last accepted one — there is no frequency bound', async () => {
    // PRICE_MIN_INTERVAL is gone (§10.6). lastGovernanceHeight is still read
    // and printed, but nothing refuses on it.
    expect(await plan({}, { lastGovernanceHeight: HEAD - 1 }).then((b) => b.checks)).toEqual([])
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
    expect(blockingChecks(built.checks)).toHaveLength(1)
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
    expect(blockingChecks(built.checks)).toHaveLength(1)
    expect(messages(built)).toContain('§11.5')
    expect(messages(built)).toContain('never be mined')
  })

  it('warns — and still sends — below the operational floor', async () => {
    const built = await plan({}, {}, 5)
    expect(blockingChecks(built.checks)).toEqual([])
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
    await expect(planGovernance(rpc, source(), params)).rejects.toThrow(/whole number of luna/)
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
    expect(lines).toContain('40000000 luna (400 NIM) → 50000000 luna (500 NIM)')
    expect(lines).toContain('250 bp → 300 bp')
    expect(lines).toContain(`effective at height ${EFFECTIVE} — head is ${HEAD}`)
    expect(lines).toContain('~25.0 h from now')
    expect(lines).toContain('NQ38 NKD4 7ALG YRDQ DXL8 PARE 7JRS JGJD MAU8')
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
    const same = describeGovernancePlan(await plan({ feeBase: LAUNCH_PRICES.feeBase })).join('\n')
    expect(same).toContain('yearly fees   1–2 80,000 NIM · 3 40,000 NIM · 4 20,000 NIM · 5 10,000 NIM · 6 4,000 NIM · 7–11 2,000 NIM · 12+ 400 NIM (unchanged)')
  })

  it('prints every band’s yearly fee under the proposed base — the readback a misplaced decimal shows up in', async () => {
    // One fee since 2026-09-11, seven frozen multipliers on top of it: the
    // luna the operator typed is not the number to check, the price of a
    // two-letter name is. Priced by core's feeFor, not multiplied here.
    const lines = describeGovernancePlan(await plan()).join('\n')
    expect(lines).toContain('yearly fees   1–2 80,000 NIM · 3 40,000 NIM · 4 20,000 NIM · 5 10,000 NIM · 6 4,000 NIM · 7–11 2,000 NIM · 12+ 400 NIM')
    expect(lines).toContain('→ 1–2 100,000 NIM · 3 50,000 NIM · 4 25,000 NIM · 5 12,500 NIM · 6 5,000 NIM · 7–11 2,500 NIM · 12+ 500 NIM')
    const tenfold = describeGovernancePlan(await plan({ feeBase: LAUNCH_PRICES.feeBase * 10n })).join('\n')
    expect(tenfold).toContain('→ 1–2 800,000 NIM')
    expect(tenfold).toContain('Check the decimal point')
  })

  it('names the last P and any pending change — the two things a P has to be planned around', async () => {
    const built = await plan(
      {},
      {
        lastGovernanceHeight: HEAD - 604_800,
        pending: { prices: LAUNCH_PRICES, effectiveHeight: HEAD + 1_000 },
      },
    )
    const lines = describeGovernancePlan(built).join('\n')
    expect(lines).toContain(`last P      height ${HEAD - 604_800}`)
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

describe('broadcast', () => {
  it('unlocks by address, then sends with the probed parameter order and the plan head', async () => {
    const { rpc, calls } = fakeRpc()
    const built = await planGovernance(rpc, source(), params)
    const outcome = await broadcast(rpc, built)

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
    const built = await planGovernance(rpc, source(), { ...params, effectiveHeight: HEAD })
    await expect(broadcast(rpc, built)).rejects.toThrow(AdminRefusal)
    expect(calls.map((call) => call.method)).toEqual(['getBlockNumber', 'getAccountByAddress'])
  })
})

describe('parseGovernanceArgs', () => {
  it('is a dry run unless --send is passed, and takes luna and basis points', () => {
    expect(parseGovernanceArgs(['50000000', '300', '58150000'])).toEqual({
      params: { feeBase: 50_000_000n, commissionBp: 300n, effectiveHeight: 58_150_000 },
      send: false,
    })
    expect(parseGovernanceArgs(['50000000', '300', '58150000', '--send']).send).toBe(true)
    // Flag position does not matter.
    expect(parseGovernanceArgs(['--send', '50000000', '300', '58150000']).send).toBe(true)
  })

  it('rejects a missing, fractional or extra argument, and any flag that is not --send', () => {
    expect(() => parseGovernanceArgs(['50000000', '300'])).toThrow(UsageError)
    expect(() => parseGovernanceArgs(['50000000', '300', '58150000', 'extra', 'more'])).toThrow(UsageError)
    expect(() => parseGovernanceArgs(['5000.5', '300', '58150000'])).toThrow(/luna/)
    expect(() => parseGovernanceArgs(['50000000', '3.5', '58150000'])).toThrow(UsageError)
    expect(() => parseGovernanceArgs(['50000000', '300', '58150000.5'])).toThrow(UsageError)
    expect(() => parseGovernanceArgs(['50000000', '300', '58150000', '--sned'])).toThrow(UsageError)
  })

  it('names the two-fee habit rather than reading the old commission as a height', () => {
    // Through 2026-09-10 p took fee_standard, fee_long, commission, height.
    expect(() => parseGovernanceArgs(['200000000', '40000000', '250', '58150000'])).toThrow(/ONE fee since 2026-09-11/)
  })
})
