import { describe, expect, it } from 'vitest'
import { BURN_ADDRESS, CONSTANTS, encodeBurn } from '@nimiqnames/core'

import { AdminRefusal, blockingChecks, broadcast, UsageError, type AdminRpc } from './cli.js'
import {
  confirmBurn,
  createBurnSource,
  describeBurnPlan,
  parseBurnArgs,
  parseBurnStatus,
  planBurn,
  SWEEP_LIMIT,
  TREASURY_HEADROOM,
  type BurnSource,
  type BurnStatus,
  type TreasuryOwes,
} from './burn.js'

const TREASURY = CONSTANTS.TREASURY_ADDRESS
/** The parsed export — CONSTANTS.BURN_ADDRESS is the raw spaced string. */
const BURN = BURN_ADDRESS


const HEAD = 58_099_950
const HASH = 'c0ffee'.repeat(10) + 'c0ff'
/** `NNS1F` in lowercase hex — what the node returns as `recipientData`. */
const F_HEX = '4e4e533146'

/** A healthy §10.2 state: 10,000 NIM revenue, 2,000 owed, 500 burned. */
const STATUS: BurnStatus = {
  revenue: 1_000_000_000n,
  owed: 200_000_000n,
  burned: 50_000_000n,
  height: HEAD - 300,
  url: 'http://api.test/burn',
}
const OUTSTANDING = STATUS.owed - STATUS.burned // 150,000,000 luna = 1,500 NIM

const NO_DEBTS: TreasuryOwes = { total: 0n, legs: 0 }

interface RecordedCall {
  readonly method: string
  readonly params: readonly unknown[]
}

interface HistoryEntry {
  readonly hash: string
  readonly blockNumber: number
  readonly recipientData: string
  readonly executionResult: boolean
  readonly value: number
}

function fakeRpc(options: { balance?: number; history?: readonly HistoryEntry[] } = {}): {
  rpc: AdminRpc
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const rpc: AdminRpc = {
    call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      calls.push({ method, params })
      switch (method) {
        case 'getBlockNumber':
          return Promise.resolve(HEAD as T)
        case 'getAccountByAddress':
          return Promise.resolve({ balance: options.balance ?? 1_000_000_000 } as T)
        case 'getTransactionsByAddress':
          return Promise.resolve((options.history ?? []) as T)
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

function source(status: BurnStatus = STATUS, owes: TreasuryOwes = NO_DEBTS): BurnSource {
  return {
    fetchBurn: () => Promise.resolve(status),
    fetchTreasuryOwes: () => Promise.resolve(owes),
    fetchAttestations: () => Promise.resolve([]),
  }
}

describe('parseBurnArgs', () => {
  it('takes one whole-luna amount and is a dry run unless --send is passed', () => {
    expect(parseBurnArgs(['150000000'])).toEqual({ params: { amount: 150_000_000n }, send: false })
    expect(parseBurnArgs(['150000000', '--send']).send).toBe(true)
    expect(parseBurnArgs(['--send', '1']).send).toBe(true)
  })

  it('refuses fractions, signs, zero, and anything that is not one amount', () => {
    for (const argv of [[], ['1.5'], ['-3'], ['1e6'], ['0'], ['1', '2'], ['abc']]) {
      expect(() => parseBurnArgs(argv), JSON.stringify(argv)).toThrow(UsageError)
    }
  })
})

describe('planBurn refusals', () => {
  it('refuses over-owed: the ceiling is owed − burned, and BURN_ADDRESS gives nothing back', async () => {
    const { rpc } = fakeRpc()
    const plan = await planBurn(rpc, source(), { amount: OUTSTANDING + 1n })
    const blocking = blockingChecks(plan.checks)
    expect(blocking).toHaveLength(1)
    expect(blocking[0]?.message).toContain('over-owed')
    expect(blocking[0]?.message).toContain('unrecoverable')
    await expect(broadcast(rpc, plan)).rejects.toThrow(AdminRefusal)
  })

  it('refuses when nothing is owed — burned already covers owed', async () => {
    const { rpc } = fakeRpc()
    const covered = { ...STATUS, burned: STATUS.owed }
    const plan = await planBurn(rpc, source(covered), { amount: 1n })
    expect(blockingChecks(plan.checks)[0]?.message).toContain('nothing is owed')
  })

  it('refuses over-balance: an unfunded burn is accepted by the RPC and never mined (§11.5)', async () => {
    // Balance covers only half the burn. This is a refusal, not p's warning:
    // the value is the whole amount, so under-balance means this exact
    // transaction cannot mine.
    const { rpc } = fakeRpc({ balance: Number(OUTSTANDING / 2n) })
    const plan = await planBurn(rpc, source(), { amount: OUTSTANDING })
    const blocking = blockingChecks(plan.checks)
    expect(blocking).toHaveLength(1)
    expect(blocking[0]?.message).toContain('§11.5')
    expect(blocking[0]?.message).toContain('never be mined')
    await expect(broadcast(rpc, plan)).rejects.toThrow(AdminRefusal)
  })

  it('refuses a stale ceiling: the node shows an executed F above the /burn snapshot', async () => {
    // The dangerous direction of staleness: an F mined after the snapshot is
    // not inside `burned`, so owed − burned would propose money already
    // burned. The sweep sees it at the node and the plan refuses outright.
    const uncounted: HistoryEntry = {
      hash: 'ab'.repeat(32),
      blockNumber: STATUS.height + 10,
      recipientData: F_HEX,
      executionResult: true,
      value: 25_000_000,
    }
    const { rpc } = fakeRpc({ history: [uncounted] })
    const plan = await planBurn(rpc, source(), { amount: 1n })
    const blocking = blockingChecks(plan.checks)
    expect(blocking).toHaveLength(1)
    expect(blocking[0]?.message).toContain('stale ceiling')
    expect(blocking[0]?.message).toContain(String(STATUS.height))
    expect(plan.uncounted).toEqual([{ hash: uncounted.hash, blockNumber: uncounted.blockNumber, value: 25_000_000n }])
    await expect(broadcast(rpc, plan)).rejects.toThrow(AdminRefusal)
  })

  it('refuses an inconclusive sweep: a full window entirely above the snapshot proves nothing', async () => {
    // BURN_ADDRESS takes anyone's dust, so SWEEP_LIMIT newer transactions
    // push an uncounted F off the end of the window. None of these entries
    // is an F — the danger is precisely what cannot be seen.
    const history: HistoryEntry[] = Array.from({ length: SWEEP_LIMIT }, (_, i) => ({
      hash: i.toString(16).padStart(64, '0'),
      blockNumber: STATUS.height + 1 + i,
      recipientData: '4e4e533153', // S dust
      executionResult: true,
      value: 1,
    }))
    const { rpc } = fakeRpc({ history })
    const plan = await planBurn(rpc, source(), { amount: 1n })
    expect(plan.sweepConclusive).toBe(false)
    const blocking = blockingChecks(plan.checks)
    expect(blocking).toHaveLength(1)
    expect(blocking[0]?.message).toContain('inconclusive sweep')
    await expect(broadcast(rpc, plan)).rejects.toThrow(AdminRefusal)
    // The same window with one entry at the snapshot height is conclusive.
    const anchored = [...history.slice(0, SWEEP_LIMIT - 1), { ...history[0]!, blockNumber: STATUS.height }]
    const { rpc: rpc2 } = fakeRpc({ history: anchored })
    const plan2 = await planBurn(rpc2, source(), { amount: 1n })
    expect(plan2.sweepConclusive).toBe(true)
    expect(blockingChecks(plan2.checks)).toEqual([])
  })

  it('the sweep ignores counted burns, failed executions, and non-F traffic to BURN_ADDRESS', async () => {
    const history: HistoryEntry[] = [
      // At the snapshot height: already inside `burned`.
      { hash: '01'.repeat(32), blockNumber: STATUS.height, recipientData: F_HEX, executionResult: true, value: 1 },
      // Failed transactions are still in blocks — discarded before any rule.
      { hash: '02'.repeat(32), blockNumber: STATUS.height + 5, recipientData: F_HEX, executionResult: false, value: 1 },
      // An S pointing a name at the burn address — dust, not a burn.
      { hash: '03'.repeat(32), blockNumber: STATUS.height + 6, recipientData: '4e4e533153', executionResult: true, value: 1 },
    ]
    const { rpc } = fakeRpc({ history })
    const plan = await planBurn(rpc, source(), { amount: 1n })
    expect(plan.uncounted).toEqual([])
    expect(blockingChecks(plan.checks)).toEqual([])
  })
})

describe('planBurn', () => {
  it('plans a clean burn: builder bytes, read-only calls, no checks', async () => {
    const { rpc, calls } = fakeRpc()
    const plan = await planBurn(rpc, source(), { amount: OUTSTANDING })
    const expected = encodeBurn({ amount: OUTSTANDING, sender: TREASURY })
    expect(plan.recipient).toBe(BURN)
    expect(plan.data).toBe(expected.data)
    expect(plan.value).toBe(OUTSTANDING)
    expect(plan.checks).toEqual([])
    expect(Buffer.from(plan.data, 'hex').toString('ascii')).toBe('NNS1F')
    // Planning is read-only: nothing is unlocked, nothing is sent.
    expect(calls.map((c) => c.method)).toEqual(['getBlockNumber', 'getAccountByAddress', 'getTransactionsByAddress'])
  })

  it('warns when the remainder falls below outstanding treasury debts plus headroom', async () => {
    // Balance exactly covers burn + debts; the headroom is what is missing.
    const owes: TreasuryOwes = { total: 40_000_000n, legs: 2 }
    const { rpc } = fakeRpc({ balance: Number(OUTSTANDING + owes.total) })
    const plan = await planBurn(rpc, source(STATUS, owes), { amount: OUTSTANDING })
    expect(blockingChecks(plan.checks)).toEqual([])
    expect(plan.checks).toHaveLength(1)
    expect(plan.checks[0]).toMatchObject({ severity: 'warn' })
    expect(plan.checks[0]?.message).toContain('refunds are paid from this address')
    expect(plan.checks[0]?.message).toContain(String(TREASURY_HEADROOM))
  })
})

describe('describeBurnPlan', () => {
  it('states what the ceiling was checked against and how stale that was', async () => {
    // The user-facing rule: the /burn height beside the current head, so an
    // operator acting on old data sees it before --send, not after.
    const { rpc } = fakeRpc()
    const plan = await planBurn(rpc, source(), { amount: OUTSTANDING })
    const lines = describeBurnPlan(plan).join('\n')
    expect(lines).toContain(`${STATUS.url} at height ${STATUS.height}`)
    expect(lines).toContain(`head is ${HEAD}`)
    expect(lines).toContain(`${HEAD - STATUS.height} blocks`)
  })

  it('decodes the payload it built and prints the wire value, the two addresses, and IRREVERSIBLE', async () => {
    const { rpc } = fakeRpc()
    const plan = await planBurn(rpc, source(), { amount: OUTSTANDING })
    const lines = describeBurnPlan(plan).join('\n')
    expect(lines).toContain('4e4e533146')
    expect(lines).toContain('decoded: F, no fields')
    expect(lines).toContain('1500 NIM')
    expect(lines).toContain('BURN_ADDRESS — no key exists')
    expect(lines).toContain('TREASURY_ADDRESS')
    expect(lines).toContain('IRREVERSIBLE')
  })

  it('throws rather than print a plan whose payload is not an F', async () => {
    const { rpc } = fakeRpc()
    const plan = await planBurn(rpc, source(), { amount: 1n })
    expect(() => describeBurnPlan({ ...plan, data: '4e4e5331556e696d6971' })).toThrow(/does not parse back as one/)
  })
})

describe('broadcast', () => {
  it('unlocks the treasury by address, then sends with the probed parameter order and the plan head', async () => {
    const { rpc, calls } = fakeRpc()
    const plan = await planBurn(rpc, source(), { amount: OUTSTANDING })
    const outcome = await broadcast(rpc, plan)
    expect(outcome).toEqual({ validityStartHeight: HEAD, hash: HASH })
    const sent = calls.filter((c) => c.method === 'unlockAccount' || c.method === 'sendBasicTransactionWithData')
    expect(sent[0]?.params).toEqual([TREASURY, null, null])
    // [wallet, recipient, dataHex, value, fee, validityStartHeight].
    expect(sent[1]?.params).toEqual([TREASURY, BURN, plan.data, Number(OUTSTANDING), 0, HEAD])
  })
})

describe('confirmBurn', () => {
  it('confirms when the attestation appears, matching the hash case-insensitively', async () => {
    let polls = 0
    const confirmed = await confirmBurn(
      () => {
        polls += 1
        return Promise.resolve(polls < 3 ? [] : [{ txHash: HASH.toUpperCase() }])
      },
      HASH,
      { attempts: 5, sleep: () => Promise.resolve() },
    )
    expect(confirmed).toBe(true)
    expect(polls).toBe(3)
  })

  it('gives up honestly after the attempts run out', async () => {
    const confirmed = await confirmBurn(() => Promise.resolve([]), HASH, {
      attempts: 3,
      sleep: () => Promise.resolve(),
    })
    expect(confirmed).toBe(false)
  })
})

describe('createBurnSource.fetchAttestations', () => {
  it('answers [] on a transport failure — it runs after the money has left', async () => {
    // A refused connection mid-poll must read as "not seen yet", never abort
    // the confirm loop into a stack trace: the loop's whole job is ending in
    // either "confirmed" or the honest UNCONFIRMED wording.
    const dead = createBurnSource('http://127.0.0.1:1')
    await expect(dead.fetchAttestations()).resolves.toEqual([])
  })
})

describe('parseBurnStatus', () => {
  it('reads both §10.2 halves and the as-of height', () => {
    const status = parseBurnStatus(
      { revenue: '1000000000', owed: '200000000', burned: '50000000', height: 58_099_650, attestations: [] },
      'http://api.test/burn',
    )
    expect(status).toEqual({ ...STATUS })
  })

  it('names the missing owed half rather than failing on it later — a pre-2026-08-17 API has no ceiling', () => {
    expect(() => parseBurnStatus({ burned: '1', height: 1 }, 'http://api.test/burn')).toThrow(/no "owed" field/)
  })
})
