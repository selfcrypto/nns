/**
 * The issuer.
 *
 * Almost all of it runs without a node, a key or a database: `issue.ts` takes
 * the RPC, the wallet and the ledger as structural types precisely so that the
 * claims worth checking — the order of the six steps, §11.5's precheck, and the
 * fact that a resume re-sends stored bytes rather than rebuilt ones — are
 * checked directly rather than inferred from a live run.
 *
 * The Postgres-gated half is the one thing a fake ledger cannot show: that the
 * order survives a real crash, because the process is thrown away between the
 * pin and the send and a new one finishes the job.
 *
 *   NNS_TEST_DATABASE_URL=postgres://…/throwaway pnpm vitest run --project settlement
 *
 * **This suite owns the schema `issue_test`**, like `ledger.test.ts` owns
 * `settlement_test`, so both can point at one throwaway database at once.
 */

import { formatAddress, LUNA_PER_NIM, type Address, type ObligationKind } from '@nimiqnames/core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPool, migrateLedger, type Pool } from './db.js'
import {
  buildPlan,
  describeIssue,
  issueFailed,
  issuePass,
  jsonLuna,
  resolveExpiryBlocks,
  resumeOf,
  sendParams,
  IssueError,
  type IssuerLedger,
  type IssuerRpc,
  type LegOutcome,
  type Wallet,
} from './issue.js'
import { createLedger, type LedgerEntry, type LiveAttempt, type TransactionPlan } from './ledger.js'
import { MARKETPLACE, SELLER, TREASURY, WINNER, testConfig } from './test-fixtures.js'
import type { DueObligation, WatchSnapshot } from './watch.js'

const config = testConfig()

const HEAD = 1_500
const EXPIRY = 120

// ── Fakes ───────────────────────────────────────────────────────────────────

const entry = (
  overrides: Partial<LedgerEntry> & Pick<LedgerEntry, 'ref' | 'kind' | 'amount'>,
): LedgerEntry => ({
  key: `${overrides.ref.height}:${overrides.ref.txIndex}:${overrides.kind}`,
  owedBy: MARKETPLACE,
  owedTo: SELLER,
  state: 'DUE',
  firstSeenHeight: 1_440,
  confirmedHeight: null,
  attemptCount: 0,
  live: null,
  ...overrides,
})

const attempt = (overrides: Partial<LiveAttempt> = {}): LiveAttempt => ({
  attemptNo: 1,
  state: 'PINNED',
  sender: MARKETPLACE,
  recipient: SELLER,
  value: 500_00000n,
  fee: 0n,
  data: '4e4e53314d313031307c30',
  validityStartHeight: 1_400,
  expiresAfter: 1_520,
  txHash: null,
  ...overrides,
})

interface Recorder {
  readonly calls: string[]
}

function fakeLedger(entries: readonly LedgerEntry[], recorder: Recorder): IssuerLedger & { pins: TransactionPlan[] } {
  const pins: TransactionPlan[] = []
  return {
    pins,
    entries: async () => {
      recorder.calls.push('entries')
      return entries
    },
    dueForIssue: async () => {
      recorder.calls.push('dueForIssue')
      return entries.filter((item) => item.state === 'DUE' && item.live === null)
    },
    pin: async (plan) => {
      recorder.calls.push(`pin ${plan.ref.height}:${plan.ref.txIndex}:${plan.kind}`)
      pins.push(plan)
      return 1
    },
    markSent: async (ref, kind, attemptNo, txHash) => {
      recorder.calls.push(`markSent ${ref.height}:${ref.txIndex}:${kind} #${attemptNo} ${txHash}`)
    },
  }
}

function fakeRpc(recorder: Recorder, balances: Record<string, number>, onSend?: () => never): IssuerRpc {
  let nonce = 0
  return {
    async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      recorder.calls.push(method)
      if (method === 'getBlockNumber') return HEAD as T
      if (method === 'getAccountByAddress') {
        const address = String(params[0])
        return { address, balance: balances[address] ?? 0 } as T
      }
      if (method === 'sendBasicTransactionWithData') {
        if (onSend !== undefined) onSend()
        nonce += 1
        return `hash${nonce}` as T
      }
      throw new Error(`unexpected method ${method}`)
    },
  }
}

const fakeWallet = (recorder: Recorder, senders: readonly Address[] = [MARKETPLACE, TREASURY]): Wallet => ({
  senders,
  async withSigningKey(sender, body) {
    recorder.calls.push(`unlock ${formatAddress(sender)}`)
    try {
      return await body()
    } finally {
      recorder.calls.push(`lock ${formatAddress(sender)}`)
    }
  },
})

const pass = (
  entries: readonly LedgerEntry[],
  options: { send?: boolean; balances?: Record<string, number>; limit?: number; senders?: readonly Address[]; onSend?: () => never } = {},
) => {
  const recorder: Recorder = { calls: [] }
  const ledger = fakeLedger(entries, recorder)
  const balances = options.balances ?? { [MARKETPLACE]: 1_000_00000, [TREASURY]: 1_000_00000 }
  return {
    recorder,
    ledger,
    report: issuePass({
      rpc: fakeRpc(recorder, balances, options.onSend),
      ledger,
      config,
      wallet: options.send === true ? fakeWallet(recorder, options.senders) : undefined,
      feeLuna: 0n,
      expiryBlocks: EXPIRY,
      minBalance: 100_00000n,
      limit: options.limit,
    }),
  }
}

const kinds = (outcomes: readonly LegOutcome[]): string[] => outcomes.map((outcome) => `${outcome.key} ${outcome.kind}`)

// ── Building one M ──────────────────────────────────────────────────────────

describe('buildPlan', () => {
  const leg = entry({ ref: { height: 1_010, txIndex: 2 }, kind: 'SALE_PROCEEDS', amount: 487_50001n })

  it('is core.encodeSettlement plus two chain facts', () => {
    const plan = buildPlan(config, leg, HEAD, 0n, EXPIRY)
    expect(plan.recipient).toBe(SELLER)
    expect(plan.sender).toBe(MARKETPLACE)
    expect(plan.value).toBe(487_50001n)
    // NNS1M1010|2 — the payload §6 M specifies, hex as the RPC requires.
    expect(Buffer.from(plan.data, 'hex').toString('ascii')).toBe('NNS1M1010|2')
    expect(plan.validityStartHeight).toBe(HEAD)
    expect(plan.expiresAfter).toBe(HEAD + EXPIRY)
  })

  it('pays from owedBy, so §6 M’s sender rule needs no branch on message type', () => {
    const refund = entry({ ref: { height: 1_020, txIndex: 0 }, kind: 'REFUND', amount: 200_00000n, owedBy: TREASURY, owedTo: WINNER })
    expect(buildPlan(config, refund, HEAD, 0n, EXPIRY).sender).toBe(TREASURY)
  })

  it('a §10.7 share is paid from the treasury to the referrer’s target, as any other leg', () => {
    const share = entry({ ref: { height: 1_030, txIndex: 0 }, kind: 'REFERRAL_SHARE', amount: 4_00000n, owedBy: TREASURY, owedTo: WINNER })
    const plan = buildPlan(config, share, HEAD, 0n, EXPIRY)
    expect(plan.sender).toBe(TREASURY)
    expect(plan.recipient).toBe(WINNER)
    expect(plan.value).toBe(4_00000n)
    expect(Buffer.from(plan.data, 'hex').toString('ascii')).toBe('NNS1M1030|0')
  })

  it('a §10.7 rebate is paid from the treasury to the buyer, under the same G’s ref', () => {
    const rebate = entry({ ref: { height: 1_030, txIndex: 0 }, kind: 'REFERRAL_REBATE', amount: 4_00000n, owedBy: TREASURY, owedTo: SELLER })
    const plan = buildPlan(config, rebate, HEAD, 0n, EXPIRY)
    expect(plan.sender).toBe(TREASURY)
    expect(plan.recipient).toBe(SELLER)
    // Same `M` reference as the share: one `G`, two payouts, told apart by
    // the payee — which is why §6 `M`'s four coordinates still identify each.
    expect(Buffer.from(plan.data, 'hex').toString('ascii')).toBe('NNS1M1030|0')
  })

  it('refuses a zero-luna leg, because the network rejects value 0', () => {
    const zero = entry({ ref: { height: 1_010, txIndex: 2 }, kind: 'COMMISSION', amount: 0n, owedTo: TREASURY })
    expect(() => buildPlan(config, zero, HEAD, 0n, EXPIRY)).toThrow(/value must be positive/)
  })

  it('refuses a leg whose payee is its payer — the RPC accepts those and the network drops them', () => {
    const self = entry({ ref: { height: 1_010, txIndex: 2 }, kind: 'COMMISSION', amount: 1_00000n, owedTo: MARKETPLACE })
    expect(() => buildPlan(config, self, HEAD, 0n, EXPIRY)).toThrow(/sender and recipient must differ/)
  })

  it('carries the configured fee onto the plan', () => {
    expect(buildPlan(config, leg, HEAD, 138n, EXPIRY).fee).toBe(138n)
  })
})

describe('resumeOf', () => {
  it('reads every field back out of the stored attempt, recomputing none', () => {
    const live = attempt({ validityStartHeight: 1_111, expiresAfter: 1_231 })
    const plan = resumeOf(entry({ ref: { height: 1_010, txIndex: 0 }, kind: 'SALE_PROCEEDS', amount: 500_00000n, state: 'CLAIMED', live }))
    // The head is 1_500 and this plan does not mention it. That is the point:
    // a recomputed validityStartHeight makes the retry a second valid
    // transaction, which is the double payment.
    expect(plan.validityStartHeight).toBe(1_111)
    expect(plan.expiresAfter).toBe(1_231)
    expect(plan.data).toBe(live.data)
    expect(plan.value).toBe(live.value)
  })

  it('refuses an entry with nothing pinned', () => {
    expect(() => resumeOf(entry({ ref: { height: 1, txIndex: 0 }, kind: 'REFUND', amount: 1n }))).toThrow(IssueError)
  })
})

describe('resolveExpiryBlocks', () => {
  /** The live mainnet answer, 2026-08-14: 7,200 blocks, ~2 h at 1 s blocks. */
  const MAINNET_WINDOW = 7_200

  const node = (answer: unknown): IssuerRpc => ({
    async call<T>(method: string): Promise<T> {
      if (method !== 'getPolicyConstants') throw new Error(`unexpected ${method}`)
      if (answer instanceof Error) throw answer
      return answer as T
    },
  })

  const methodNotFound = Object.assign(new Error('method not found'), { code: -32601 })

  it('takes the node’s own window when nothing overrides it', async () => {
    expect(await resolveExpiryBlocks(node({ transactionValidityWindow: MAINNET_WINDOW }), null)).toEqual({
      blocks: MAINNET_WINDOW,
      source: 'node',
      nodeWindow: MAINNET_WINDOW,
    })
  })

  it('lets an override wait longer than the chain requires', async () => {
    // Longer only costs a stall: the transaction has already expired on-chain
    // and the ledger waits before replacing it.
    expect(await resolveExpiryBlocks(node({ transactionValidityWindow: MAINNET_WINDOW }), 10_000)).toEqual({
      blocks: 10_000,
      source: 'override',
      nodeWindow: MAINNET_WINDOW,
    })
    expect((await resolveExpiryBlocks(node({ transactionValidityWindow: MAINNET_WINDOW }), MAINNET_WINDOW)).blocks).toBe(MAINNET_WINDOW)
  })

  it('refuses an override below the node’s window — that is the double payment', async () => {
    // 120 was this file's own placeholder before the window was probed, and it
    // is 60× too short. That is exactly the mistake now impossible to make.
    await expect(resolveExpiryBlocks(node({ transactionValidityWindow: MAINNET_WINDOW }), 120)).rejects.toThrow(
      /below the node's transactionValidityWindow of 7200/,
    )
  })

  it('falls back to the override on a node without the method', async () => {
    expect(await resolveExpiryBlocks(node(methodNotFound), 8_000)).toEqual({
      blocks: 8_000,
      source: 'override',
      nodeWindow: null,
    })
  })

  it('refuses to guess when the node cannot answer and nothing was set', async () => {
    await expect(resolveExpiryBlocks(node(methodNotFound), null)).rejects.toThrow(/no getPolicyConstants/)
  })

  it('does not swallow a real RPC failure', async () => {
    await expect(resolveExpiryBlocks(node(new Error('401 Unauthorized')), null)).rejects.toThrow('401 Unauthorized')
  })

  it('refuses a window the node did not answer with a block count', async () => {
    await expect(resolveExpiryBlocks(node({ transactionValidityWindow: '7200' }), null)).rejects.toThrow(
      /expected a positive whole number of blocks/,
    )
    await expect(resolveExpiryBlocks(node({}), null)).rejects.toThrow(IssueError)
  })
})

describe('jsonLuna', () => {
  it('passes every amount NNS can actually hold', () => {
    expect(jsonLuna(2_100_000_000n * LUNA_PER_NIM, 'supply')).toBe(210_000_000_000_000)
  })

  it('refuses an amount a JSON number would round', () => {
    expect(() => jsonLuna(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 'value')).toThrow(/MAX_SAFE_INTEGER/)
  })

  it('refuses a negative amount', () => {
    expect(() => jsonLuna(-1n, 'value')).toThrow(IssueError)
  })
})

describe('sendParams', () => {
  it('is the probed order of sendBasicTransactionWithData (§4)', () => {
    const plan: TransactionPlan = {
      ref: { height: 1_010, txIndex: 0 },
      kind: 'SALE_PROCEEDS',
      sender: MARKETPLACE,
      recipient: SELLER,
      value: 5n,
      fee: 0n,
      data: 'ab',
      validityStartHeight: 7,
      expiresAfter: 127,
    }
    expect(sendParams(plan)).toEqual([MARKETPLACE, SELLER, 'ab', 5, 0, 7])
  })
})

// ── The pass ────────────────────────────────────────────────────────────────

describe('issuePass — the order', () => {
  const leg = entry({ ref: { height: 1_010, txIndex: 0 }, kind: 'SALE_PROCEEDS', amount: 487_50001n })

  it('pins before it signs, signs before it sends, and records last', async () => {
    const run = pass([leg], { send: true })
    const report = await run.report
    expect(kinds(report.outcomes)).toEqual(['1010:0:SALE_PROCEEDS sent'])

    // The whole deliverable, as a list. `pin` precedes `unlock`, which precedes
    // the send, which precedes `markSent`; the lock closes over the send.
    const ordered = run.recorder.calls.filter((call) => !['entries', 'dueForIssue', 'getAccountByAddress'].includes(call))
    expect(ordered).toEqual([
      'getBlockNumber',
      'pin 1010:0:SALE_PROCEEDS',
      `unlock ${formatAddress(MARKETPLACE)}`,
      'sendBasicTransactionWithData',
      `lock ${formatAddress(MARKETPLACE)}`,
      'markSent 1010:0:SALE_PROCEEDS #1 hash1',
    ])
  })

  it('reads the balance before it pins anything', async () => {
    const run = pass([leg], { send: true })
    await run.report
    expect(run.recorder.calls.indexOf('getAccountByAddress')).toBeLessThan(
      run.recorder.calls.findIndex((call) => call.startsWith('pin ')),
    )
  })

  it('pins nothing and sends nothing on a dry run', async () => {
    const run = pass([leg])
    const report = await run.report
    expect(report.send).toBe(false)
    expect(kinds(report.outcomes)).toEqual(['1010:0:SALE_PROCEEDS planned'])
    expect(run.ledger.pins).toEqual([])
    expect(run.recorder.calls).not.toContain('sendBasicTransactionWithData')
    // …but it still performs §11.5's read, which is the half a rehearsal can show.
    expect(run.recorder.calls).toContain('getAccountByAddress')
    expect(report.balances[0]?.balance).toBe(1_000_00000n)
  })
})

describe('issuePass — §11.5', () => {
  const big = entry({ ref: { height: 1_010, txIndex: 0 }, kind: 'SALE_PROCEEDS', amount: 900_00000n })
  const small = entry({ ref: { height: 1_020, txIndex: 0 }, kind: 'SALE_PROCEEDS', amount: 10_00000n })

  it('refuses to sign what the sender cannot cover, and pins nothing for it', async () => {
    const run = pass([big], { send: true, balances: { [MARKETPLACE]: 100_00000 } })
    const report = await run.report
    expect(kinds(report.outcomes)).toEqual(['1010:0:SALE_PROCEEDS underfunded'])
    expect(run.ledger.pins).toEqual([])
    expect(run.recorder.calls).not.toContain('sendBasicTransactionWithData')
  })

  it('draws the balance down across a pass rather than re-checking the opening one', async () => {
    // Two legs of 900 NIM against 1,000 NIM. Checked individually both pass;
    // the second transaction would be accepted by the RPC and dropped (§5.3).
    const second = entry({ ref: { height: 1_030, txIndex: 0 }, kind: 'SALE_PROCEEDS', amount: 900_00000n })
    const report = await pass([big, second], { send: true, balances: { [MARKETPLACE]: 1_000_00000 } }).report
    expect(kinds(report.outcomes)).toEqual(['1010:0:SALE_PROCEEDS sent', '1030:0:SALE_PROCEEDS underfunded'])
  })

  it('stops a sender rather than skipping to a leg it can still afford', async () => {
    // Paying `small` here would let a later creditor jump an earlier one purely
    // on arithmetic. Debts are settled oldest first or not at all.
    const report = await pass([big, small], { send: true, balances: { [MARKETPLACE]: 100_00000 } }).report
    expect(kinds(report.outcomes)).toEqual(['1010:0:SALE_PROCEEDS underfunded', '1020:0:SALE_PROCEEDS underfunded'])
  })

  it('budgets each §6 M sender separately', async () => {
    const refund = entry({ ref: { height: 1_040, txIndex: 0 }, kind: 'REFUND', amount: 300_00000n, owedBy: TREASURY, owedTo: WINNER })
    const report = await pass([big, refund], {
      send: true,
      balances: { [MARKETPLACE]: 100_00000, [TREASURY]: 1_000_00000 },
    }).report
    expect(kinds(report.outcomes)).toEqual(['1010:0:SALE_PROCEEDS underfunded', '1040:0:REFUND sent'])
  })

  it('alerts below the threshold while still paying — rule 2 is not a refusal', async () => {
    const report = await pass([small], { send: true, balances: { [MARKETPLACE]: 50_00000 } }).report
    expect(kinds(report.outcomes)).toEqual(['1020:0:SALE_PROCEEDS sent'])
    expect(report.balances[0]?.belowThreshold).toBe(true)
    expect(describeIssue(report).join('\n')).toContain('ALERT (§11.5)')
  })

  it('refuses a balance the node did not answer with a whole number of luna', async () => {
    const recorder: Recorder = { calls: [] }
    const rpc: IssuerRpc = {
      async call<T>(method: string): Promise<T> {
        if (method === 'getBlockNumber') return HEAD as T
        return { balance: '1000' } as T
      },
    }
    await expect(
      issuePass({ rpc, ledger: fakeLedger([small], recorder), config, feeLuna: 0n, expiryBlocks: EXPIRY, minBalance: 1n }),
    ).rejects.toThrow(/expected a whole number of luna/)
  })
})

describe('issuePass — what it does not pay', () => {
  it('reports a leg core refuses to build and carries on with the rest', async () => {
    const zero = entry({ ref: { height: 1_010, txIndex: 0 }, kind: 'COMMISSION', amount: 0n, owedTo: TREASURY })
    const payable = entry({ ref: { height: 1_010, txIndex: 0 }, kind: 'SALE_PROCEEDS', amount: 500_00000n })
    const report = await pass([zero, payable], { send: true }).report
    expect(kinds(report.outcomes)).toEqual(['1010:0:COMMISSION unpayable', '1010:0:SALE_PROCEEDS sent'])
    expect(describeIssue(report).join('\n')).toContain('The debt stays standing in the log')
  })

  it('leaves a BROADCAST leg alone — a node accepting is not landing', async () => {
    const broadcast = entry({
      ref: { height: 1_010, txIndex: 0 },
      kind: 'SALE_PROCEEDS',
      amount: 500_00000n,
      state: 'BROADCAST',
      attemptCount: 1,
      live: attempt({ state: 'SENT', txHash: 'abc' }),
    })
    const run = pass([broadcast], { send: true })
    const report = await run.report
    expect(report.outcomes).toEqual([])
    expect(run.recorder.calls).not.toContain('sendBasicTransactionWithData')
  })

  it('will not sign for a sender it holds no key for, and does not pin either', async () => {
    const refund = entry({ ref: { height: 1_040, txIndex: 0 }, kind: 'REFUND', amount: 300_00000n, owedBy: TREASURY, owedTo: WINNER })
    const run = pass([refund], { send: true, senders: [MARKETPLACE] })
    const report = await run.report
    expect(report.outcomes[0]).toMatchObject({ kind: 'failed', stage: 'key' })
    expect(run.ledger.pins).toEqual([])
    expect(issueFailed(report)).toBe(true)
  })

  it('defers past --limit instead of emptying the queue in one pass', async () => {
    const legs = [0, 1, 2].map((index) =>
      entry({ ref: { height: 1_010 + index, txIndex: 0 }, kind: 'SALE_PROCEEDS', amount: 1_00000n }),
    )
    const report = await pass(legs, { send: true, limit: 2 }).report
    expect(kinds(report.outcomes)).toEqual([
      '1010:0:SALE_PROCEEDS sent',
      '1011:0:SALE_PROCEEDS sent',
      '1012:0:SALE_PROCEEDS deferred',
    ])
  })
})

describe('issuePass — two legs, one transaction', () => {
  // A `G` whose buyer overpaid by exactly the rebate: §10.5 owes the buyer a
  // REFUND and §10.7 owes the same buyer a REFERRAL_REBATE, same ref, same
  // amount, same payer. `kind` is in the ledger key and in nothing the node
  // hashes, so the two plans are the same bytes — and the node answers the
  // second send with the first one's hash.
  const surplus = 4_00000n
  const owed = (kind: LedgerEntry['kind'], amount = surplus) =>
    entry({ ref: { height: 1_010, txIndex: 0 }, kind, amount, owedBy: TREASURY, owedTo: WINNER })

  it('sends one and defers the other rather than pinning bytes the node has taken', async () => {
    const run = pass([owed('REFUND'), owed('REFERRAL_REBATE')], { send: true })
    const report = await run.report
    expect(kinds(report.outcomes)).toEqual(['1010:0:REFUND sent', '1010:0:REFERRAL_REBATE collided'])
    expect(report.outcomes[1]).toMatchObject({ withKey: '1010:0:REFUND' })
    // Nothing pinned for the deferred leg: it stays DUE and is planned afresh
    // next pass, at a later head, where the bytes differ.
    expect(run.ledger.pins).toHaveLength(1)
    expect(run.recorder.calls.filter((call) => call === 'sendBasicTransactionWithData')).toHaveLength(1)
  })

  it('pays the reducer’s leg and defers the payout, whichever order the ledger hands them over', async () => {
    // The ledger orders by key, so REFERRAL_REBATE comes first on its own —
    // and sending it first is the failure this ordering exists to prevent: an
    // `M` names a ref, a payee and an amount, the reducer claims the first one
    // that fits its leg, and the payout is then BROADCAST against a payment
    // credited to somebody else until its window expires. Measured on the era,
    // 2026-09-12.
    for (const order of [['REFERRAL_REBATE', 'REFUND'], ['REFUND', 'REFERRAL_REBATE']] as const) {
      const report = await pass(order.map((kind) => owed(kind)), { send: true }).report
      expect(kinds(report.outcomes)).toEqual(['1010:0:REFUND sent', '1010:0:REFERRAL_REBATE collided'])
    }
  })

  it('keeps a pinned resume ahead of both — its bytes are already committed', async () => {
    const live = attempt({ attemptNo: 2, sender: TREASURY, recipient: WINNER, value: surplus, validityStartHeight: HEAD, expiresAfter: HEAD + EXPIRY, data: '' })
    const pinned = entry({ ...owed('REFERRAL_SHARE'), state: 'CLAIMED', attemptCount: 2, live: { ...live, data: buildPlan(config, owed('REFERRAL_SHARE'), HEAD, 0n, EXPIRY).data } })
    const report = await pass([pinned, owed('REFUND')], { send: true }).report
    expect(kinds(report.outcomes)).toEqual(['1010:0:REFERRAL_SHARE resent', '1010:0:REFUND collided'])
  })

  it('spends no budget on the collided leg, so the next creditor is still paid', async () => {
    const other = entry({ ref: { height: 1_011, txIndex: 0 }, kind: 'REFUND', amount: surplus, owedBy: TREASURY, owedTo: SELLER })
    const report = await pass([owed('REFUND'), owed('REFERRAL_REBATE'), other], {
      send: true,
      balances: { [TREASURY]: 8_00000 },
    }).report
    expect(kinds(report.outcomes)).toEqual([
      '1010:0:REFUND sent',
      '1010:0:REFERRAL_REBATE collided',
      '1011:0:REFUND sent',
    ])
  })

  it('leaves two legs that differ by a single luna alone — they are two transactions', async () => {
    const report = await pass([owed('REFUND'), owed('REFERRAL_REBATE', surplus - 1n)], { send: true }).report
    expect(kinds(report.outcomes)).toEqual(['1010:0:REFUND sent', '1010:0:REFERRAL_REBATE sent'])
  })

  it('says so on a dry run too, because that is what --send would do', async () => {
    const report = await pass([owed('REFUND'), owed('REFERRAL_REBATE')]).report
    expect(kinds(report.outcomes)).toEqual(['1010:0:REFUND planned', '1010:0:REFERRAL_REBATE collided'])
    expect(describeIssue(report).some((line) => line.includes('COLLIDED'))).toBe(true)
  })
})

describe('issuePass — resuming a pinned attempt', () => {
  const live = attempt({ validityStartHeight: 1_400, expiresAfter: 1_520, attemptNo: 3 })
  const claimed = entry({
    ref: { height: 1_010, txIndex: 0 },
    kind: 'SALE_PROCEEDS',
    amount: 500_00000n,
    state: 'CLAIMED',
    attemptCount: 3,
    live,
  })

  it('re-sends the stored bytes verbatim and pins nothing new', async () => {
    const run = pass([claimed], { send: true })
    const report = await run.report
    expect(kinds(report.outcomes)).toEqual(['1010:0:SALE_PROCEEDS resent'])
    expect(run.ledger.pins).toEqual([])
    // Identical bytes and the *stored* validityStartHeight: the network
    // collapses this to the hash the first attempt already had.
    expect(sendParams((report.outcomes[0] as { plan: TransactionPlan }).plan)).toEqual([
      MARKETPLACE,
      SELLER,
      live.data,
      50000000,
      0,
      1_400,
    ])
    expect(run.recorder.calls).toContain('markSent 1010:0:SALE_PROCEEDS #3 hash1')
  })

  it('does not re-send an attempt already past its window', async () => {
    const dead = entry({ ...claimed, live: attempt({ attemptNo: 3, expiresAfter: HEAD - 1 }) })
    const run = pass([dead], { send: true })
    const report = await run.report
    expect(kinds(report.outcomes)).toEqual(['1010:0:SALE_PROCEEDS stalled'])
    expect(run.recorder.calls).not.toContain('sendBasicTransactionWithData')
  })

  it('settles resumes before new legs, so the balance stands behind promises already made', async () => {
    const fresh = entry({ ref: { height: 1_005, txIndex: 0 }, kind: 'SALE_PROCEEDS', amount: 500_00000n })
    // 1_005 sorts before 1_010, and the resume still goes first.
    const report = await pass([claimed, fresh], { send: true, balances: { [MARKETPLACE]: 500_00000 } }).report
    expect(kinds(report.outcomes)).toEqual(['1010:0:SALE_PROCEEDS resent', '1005:0:SALE_PROCEEDS underfunded'])
  })
})

describe('issuePass — failure', () => {
  const leg = entry({ ref: { height: 1_010, txIndex: 0 }, kind: 'SALE_PROCEEDS', amount: 500_00000n })

  it('leaves a failed send pinned, unrecorded, and reported', async () => {
    const run = pass([leg], {
      send: true,
      onSend: () => {
        throw new Error('connection refused')
      },
    })
    const report = await run.report
    expect(report.outcomes[0]).toMatchObject({ kind: 'failed', stage: 'send' })
    // Pinned, so the next pass re-sends these exact bytes: one stall, no money.
    expect(run.ledger.pins).toHaveLength(1)
    expect(run.recorder.calls.some((call) => call.startsWith('markSent'))).toBe(false)
    // The lock still ran — an unlocked hot key is the thing a thrown send must
    // not leave behind.
    expect(run.recorder.calls).toContain(`lock ${formatAddress(MARKETPLACE)}`)
    expect(issueFailed(report)).toBe(true)
  })

  it('keeps paying the other creditors when one leg fails', async () => {
    let first = true
    const run = pass(
      [leg, entry({ ref: { height: 1_020, txIndex: 0 }, kind: 'SALE_PROCEEDS', amount: 1_00000n })],
      {
        send: true,
        onSend: () => {
          if (first) {
            first = false
            throw new Error('nope')
          }
          throw new Error('unreachable')
        },
      },
    )
    // The second send throws too in this fake, so assert only that the pass got
    // there: a settlement service whose failure mode is "pays nobody" is worse
    // than one that reports two errors.
    const report = await run.report
    expect(report.outcomes.map((outcome) => outcome.kind)).toEqual(['failed', 'failed'])
  })

  it('is clean when nothing failed', async () => {
    expect(issueFailed(await pass([leg], { send: true }).report)).toBe(false)
  })
})

describe('describeIssue', () => {
  it('says plainly which mode it is in', async () => {
    expect(describeIssue(await pass([], {}).report).join('\n')).toContain('dry run')
    expect(describeIssue(await pass([], { send: true }).report).join('\n')).toContain('these transactions are real')
  })
})

// ── The order, against a real ledger ────────────────────────────────────────

const URL = process.env['NNS_TEST_DATABASE_URL']
const SCHEMA = 'issue_test'
const POOL_URL =
  URL === undefined
    ? ''
    : `${URL}${URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`

describe.skipIf(URL === undefined)('issuePass over a real ledger', () => {
  let pool: Pool

  const ledgerOf = () => createLedger({ pool, config, apiUrl: 'http://api.test' })

  const leg = (kind: ObligationKind, amount: bigint, owedTo: Address, owedBy: Address = MARKETPLACE): DueObligation => ({
    key: `1010:0:${kind}`,
    kind,
    ref: { height: 1_010, txIndex: 0 },
    owedBy,
    owedTo,
    amount,
    ageBlocks: 430,
  })

  const snapshotOf = (height: number, due: readonly DueObligation[]): WatchSnapshot =>
    Object.freeze({
      checkpointHeight: height,
      logHash: `${height}`.padStart(64, '0'),
      lineCount: due.length,
      due: Object.freeze(due),
      totalDue: due.reduce((sum, item) => sum + item.amount, 0n),
      unmatched: Object.freeze([]),
      mispaidShares: Object.freeze([]),
      unpricedShares: Object.freeze([]),
    })

  beforeAll(async () => {
    pool = createPool(POOL_URL)
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`)
  })

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`)
    await migrateLedger(pool)
  })

  const run = (
    ledger: IssuerLedger,
    recorder: Recorder,
    options: { send?: boolean; onSend?: () => never } = {},
  ) =>
    issuePass({
      rpc: fakeRpc(recorder, { [MARKETPLACE]: 1_000_00000, [TREASURY]: 1_000_00000 }, options.onSend),
      ledger,
      config,
      wallet: options.send === true ? fakeWallet(recorder) : undefined,
      feeLuna: 0n,
      expiryBlocks: EXPIRY,
      minBalance: 100_00000n,
    })

  it('settles both legs of a winning B and confirms them from the log', async () => {
    const ledger = ledgerOf()
    await ledger.initialise()
    await ledger.applySnapshot(
      snapshotOf(1_440, [leg('SALE_PROCEEDS', 487_50001n, SELLER), leg('COMMISSION', 12_50000n, TREASURY)]),
    )

    const recorder: Recorder = { calls: [] }
    const report = await run(ledger, recorder, { send: true })
    expect(kinds(report.outcomes)).toEqual(['1010:0:COMMISSION sent', '1010:0:SALE_PROCEEDS sent'])

    const entries = await ledger.entries()
    expect(entries.map((item) => item.state)).toEqual(['BROADCAST', 'BROADCAST'])
    expect(entries.map((item) => item.live?.txHash)).toEqual(['hash1', 'hash2'])

    // The log stops saying they are owed, at a stamped height. No node is asked.
    await ledger.applySnapshot(snapshotOf(2_160, []))
    expect((await ledger.summary()).confirmed).toBe(2)
  })

  it('a crash between the pin and the send costs one stall and no money', async () => {
    const first = ledgerOf()
    await first.initialise()
    await first.applySnapshot(snapshotOf(1_440, [leg('SALE_PROCEEDS', 487_50001n, SELLER)]))

    const crashed: Recorder = { calls: [] }
    const failedReport = await run(first, crashed, {
      send: true,
      onSend: () => {
        throw new Error('the process died here')
      },
    })
    expect(failedReport.outcomes[0]).toMatchObject({ kind: 'failed', stage: 'send' })

    // A new object over the same database is what a restart actually is.
    const restarted = ledgerOf()
    await restarted.initialise()
    const recorder: Recorder = { calls: [] }
    const report = await run(restarted, recorder, { send: true })

    // Re-sent, not re-planned: same attempt number, and the validityStartHeight
    // the first process pinned rather than the head this one read.
    expect(report.outcomes[0]).toMatchObject({ kind: 'resent', attemptNo: 1 })
    const plan = (report.outcomes[0] as { plan: TransactionPlan }).plan
    expect(plan.validityStartHeight).toBe(HEAD)
    expect(await restarted.dueForIssue()).toEqual([])
    expect((await restarted.summary()).broadcast).toBe(1)
  })

  it('a dry run against a real ledger writes nothing at all', async () => {
    const ledger = ledgerOf()
    await ledger.initialise()
    await ledger.applySnapshot(snapshotOf(1_440, [leg('SALE_PROCEEDS', 487_50001n, SELLER)]))

    const report = await run(ledger, { calls: [] })
    expect(kinds(report.outcomes)).toEqual(['1010:0:SALE_PROCEEDS planned'])
    const [only] = await ledger.entries()
    expect(only?.state).toBe('DUE')
    expect(only?.attemptCount).toBe(0)
    expect(only?.live).toBeNull()
  })
})
