import { describe, expect, it } from 'vitest'

import {
  CONSTANTS,
  commissionOn,
  encodeBuy,
  encodeOffer,
  encodeRegister,
  encodeSettlement,
  feeFor,
  initialState,
  minPrice,
} from '@nimiqnames/core'

import {
  LAUNCH_HEIGHT,
  LOSER,
  MARKETPLACE,
  SELLER,
  TREASURY,
  WINNER,
  send,
  stageLog,
  testConfig,
} from './test-fixtures.js'
import { describeReport, isSound, reconcile } from './reconcile.js'
import { parseRateTable } from './rates.js'
import { createShareCollector } from './share.js'
import { testAddress } from './test-fixtures.js'
import { replayLog } from './replay.js'

const NAME = 'alicename'
const PRICE = 70_000_001n
const COMMISSION = commissionOn(PRICE, CONSTANTS.COMMISSION_RATE)
const PROCEEDS = PRICE - COMMISSION

const config = testConfig()
const FEE = feeFor(NAME, initialState().prices)
const FLOOR = minPrice(initialState().prices)

const H = { register: LAUNCH_HEIGHT + 10, offer: LAUNCH_HEIGHT + 20, buy: LAUNCH_HEIGHT + 30, settle: LAUNCH_HEIGHT + 40 }

const scenario = [
  send(H.register, 0, SELLER, encodeRegister({ name: NAME, fee: FEE })),
  send(H.offer, 0, SELLER, encodeOffer({ name: NAME, price: PRICE, minPrice: FLOOR })),
  send(H.buy, 0, WINNER, encodeBuy({ name: NAME, price: PRICE })),
  send(H.buy, 1, LOSER, encodeBuy({ name: NAME, price: PRICE })),
  send(H.settle, 0, MARKETPLACE, encodeSettlement({ height: H.buy, txIndex: 0, payee: SELLER, amount: PROCEEDS })),
]

function reportFor(sends: typeof scenario, boundToCheckpoint = true) {
  const staged = stageLog(sends, config)
  const replay = replayLog(staged.lines, initialState(), config, LAUNCH_HEIGHT + 720)
  return reconcile({
    replay,
    checkpointHeight: LAUNCH_HEIGHT + 720,
    boundToCheckpoint,
    logHash: '00'.repeat(32),
  })
}

describe('reconcile', () => {
  it('splits the ledger by who owes it and for what', () => {
    const report = reportFor(scenario)
    const marketplace = report.lines.filter((line) => line.owedBy === MARKETPLACE)
    expect(marketplace.map((line) => line.kind).sort()).toEqual(['COMMISSION', 'REFUND', 'SALE_PROCEEDS'])

    const proceeds = marketplace.find((line) => line.kind === 'SALE_PROCEEDS')
    expect(proceeds).toMatchObject({ created: PROCEEDS, settled: PROCEEDS, outstanding: 0n })

    const commission = marketplace.find((line) => line.kind === 'COMMISSION')
    expect(commission).toMatchObject({ created: COMMISSION, settled: 0n, outstanding: COMMISSION })

    const refund = marketplace.find((line) => line.kind === 'REFUND')
    expect(refund).toMatchObject({ created: PRICE, settled: 0n, outstanding: PRICE })
  })

  it('balances, and totals what is still owed', () => {
    const report = reportFor(scenario)
    expect(report.balanced).toBe(true)
    expect(report.totalCreated).toBe(report.totalSettled + report.totalOutstanding)
    expect(report.totalCreated).toBe(PROCEEDS + COMMISSION + PRICE)
    expect(report.totalSettled).toBe(PROCEEDS)
    expect(report.totalOutstanding).toBe(COMMISSION + PRICE)
  })

  it('ages each standing obligation against the checkpoint the log was served through', () => {
    // Not against the last line: the watcher ages by the stamped height, and
    // since r28 the state itself is advanced to it (an auction can close in
    // the gap), so the two reports say the same thing about the same debt.
    const report = reportFor(scenario)
    const refund = report.standing.find((leg) => leg.kind === 'REFUND')
    expect(refund?.ageBlocks).toBe(LAUNCH_HEIGHT + 720 - H.buy)
    expect(refund?.owedTo).toBe(LOSER)
  })

  it('is sound with money outstanding — a standing debt is news, not an error', () => {
    const report = reportFor(scenario)
    expect(report.totalOutstanding).toBeGreaterThan(0n)
    expect(isSound(report)).toBe(true)
  })

  it('is unsound when a verdict disagrees with the replay', () => {
    const staged = stageLog(scenario, config)
    const tampered = staged.lines.map((line) => line.replace(/ OFFER_NOT_OPEN$/, ' OK'))
    const replay = replayLog(tampered, initialState(), config, LAUNCH_HEIGHT + 720)
    const report = reconcile({
      replay,
      checkpointHeight: LAUNCH_HEIGHT + 720,
      boundToCheckpoint: true,
      logHash: '00'.repeat(32),
    })
    expect(report.mismatches).toHaveLength(1)
    expect(isSound(report)).toBe(false)
  })

  it('an empty log is sound and owes nothing', () => {
    const report = reportFor([])
    expect(report.lines).toEqual([])
    expect(report.totalCreated).toBe(0n)
    expect(isSound(report)).toBe(true)
    expect(describeReport(report).join('\n')).toContain('no obligations have ever been created')
  })

  it('the report says plainly when the log is not bound to a checkpoint', () => {
    const bound = describeReport(reportFor(scenario, true)).join('\n')
    const unbound = describeReport(reportFor(scenario, false)).join('\n')
    expect(bound).toContain('commits this exact log')
    expect(unbound).toContain('NOT BOUND')
    expect(unbound).toContain("serving party's word alone")
  })

  it('renders luna as NIM without ever computing on the rendered form', () => {
    const report = reportFor(scenario)
    const text = describeReport(report).join('\n')
    // 70,000,001 luna is 700.00001 NIM — the fractional digits are the point.
    expect(text).toContain('700.00001')
    expect(text).toContain('1 NIM = 100,000 luna')
  })

  it('lines the ledger columns up under a 44-character address', () => {
    // `formatAddress` is 36 characters plus 8 group separators. The first run
    // of the CLI padded to 36 and every row shifted; this is that bug, pinned.
    const rows = describeReport(reportFor(scenario)).filter((line) => /^(owed by|NQ|TOTAL)/.test(line))
    expect(rows.length).toBeGreaterThan(1)
    // Equal length, and the separator after the address field falls on the
    // same character in every row — including the ones holding a real address.
    expect(new Set(rows.map((line) => line.length)).size).toBe(1)
    expect(rows.every((line) => line[44] === ' ')).toBe(true)
    expect(rows.some((line) => line.startsWith('NQ'))).toBe(true)
  })

  it('names an unmatched settlement in the output', () => {
    const withStray = [
      ...scenario,
      send(
        H.settle + 5,
        0,
        MARKETPLACE,
        encodeSettlement({ height: H.buy, txIndex: 1, payee: LOSER, amount: 1n }),
      ),
    ]
    const report = reportFor(withStray)
    expect(report.unmatched).toHaveLength(1)
    const text = describeReport(report).join('\n')
    expect(text).toContain('discharged nothing')
    // Still sound: an unmatched M is an operator problem, not a false log.
    expect(isSound(report)).toBe(true)
  })

  it('a fully settled log leaves nothing outstanding', () => {
    const settled = [
      ...scenario,
      send(
        H.settle,
        1,
        MARKETPLACE,
        encodeSettlement({ height: H.buy, txIndex: 0, payee: TREASURY, amount: COMMISSION }),
      ),
      send(
        H.settle,
        2,
        MARKETPLACE,
        encodeSettlement({ height: H.buy, txIndex: 1, payee: LOSER, amount: PRICE }),
      ),
    ]
    const report = reportFor(settled)
    expect(report.totalOutstanding).toBe(0n)
    expect(report.totalSettled).toBe(report.totalCreated)
    expect(report.standing).toEqual([])
    expect(isSound(report)).toBe(true)
  })
})

describe('reconcile — the §10.7 shares section', () => {
  const REFERRER_OWNER = testAddress(20)
  const RATES = parseRateTable({ rates: [{ ref: null, bp: 1000, fromHeight: 0 }] })
  const newcomerFee = feeFor('newcomer', initialState().prices)
  const SHARE = (newcomerFee * 1000n) / 10_000n
  const referred = [
    send(H.register, 0, REFERRER_OWNER, encodeRegister({ name: 'ricoref', fee: feeFor('ricoref', initialState().prices) })),
    send(H.offer, 0, WINNER, encodeRegister({ name: 'newcomer', fee: newcomerFee, ref: 'ricoref' })),
  ]
  const paid = send(H.settle, 0, TREASURY, encodeSettlement({ height: H.offer, txIndex: 0, payee: REFERRER_OWNER, amount: SHARE }))

  const reportWithShares = (sends: typeof referred) => {
    const staged = stageLog(sends, config)
    const collector = createShareCollector(RATES)
    const replay = replayLog(staged.lines, initialState(), config, LAUNCH_HEIGHT + 720, collector.observe)
    return reconcile({ replay, checkpointHeight: LAUNCH_HEIGHT + 720, boundToCheckpoint: true, logHash: '00'.repeat(32), shares: collector.result() })
  }

  it('reports shares apart from the reducer’s ledger, which they never enter', () => {
    const report = reportWithShares(referred)
    expect(report.lines).toEqual([])
    expect(report.totalCreated).toBe(0n)
    expect(report.shares).toMatchObject({ created: SHARE, settled: 0n, outstanding: SHARE, createdCount: 1, settledCount: 0 })
    expect(report.shares?.standing[0]).toMatchObject({ name: 'newcomer', referrer: 'ricoref', owedTo: REFERRER_OWNER, rateBp: 1000n })
    expect(isSound(report)).toBe(true)
  })

  it('a paid share is settled in its section and is not an unmatched settlement', () => {
    const report = reportWithShares([...referred, paid])
    expect(report.shares).toMatchObject({ settled: SHARE, outstanding: 0n, settledCount: 1 })
    expect(report.unmatched).toEqual([])
    expect(report.shares?.standing).toEqual([])
  })

  it('with no collector at all the section is null and the same M is an unmatched settlement', () => {
    const report = reportFor([...referred, paid])
    expect(report.shares).toBeNull()
    expect(report.unmatched).toHaveLength(1)
  })

  it('prints the section with the referrer and the rate', () => {
    const text = describeReport(reportWithShares(referred)).join('\n')
    expect(text).toContain('referral payouts (§10.7, policy — in no root)')
    expect(text).toContain('share  newcomer via ricoref at 1000 bp')
  })

  // One referral, two payouts (2026-09-12). The reader has to be able to tell
  // which `M` was which, so the section names the payout and the payee.
  describe('with a rebate row', () => {
    const SPLIT = parseRateTable({ rates: [{ ref: null, bp: 400, rebateBp: 400, selfBp: 0, fromHeight: 0 }] })
    const NET = (newcomerFee * 400n) / 10_000n
    const run = (sends: readonly (typeof referred)[number][]) => {
      const staged = stageLog(sends, config)
      const collector = createShareCollector(SPLIT)
      const replay = replayLog(staged.lines, initialState(), config, LAUNCH_HEIGHT + 720, collector.observe)
      return reconcile({ replay, checkpointHeight: LAUNCH_HEIGHT + 720, boundToCheckpoint: true, logHash: '00'.repeat(32), shares: collector.result() })
    }

    it('counts one registration and two payouts, and splits the totals', () => {
      const report = run(referred)
      expect(report.shares).toMatchObject({
        referralCount: 1,
        createdCount: 2,
        created: NET * 2n,
        shareTotal: NET,
        rebateTotal: NET,
        outstanding: NET * 2n,
      })
      expect(report.shares?.standing.map((leg) => [leg.kind, leg.owedTo])).toEqual([
        ['REFERRAL_SHARE', REFERRER_OWNER],
        ['REFERRAL_REBATE', WINNER],
      ])
      expect(isSound(report)).toBe(true)
    })

    it('prints both payouts, each with its word and its payee', () => {
      const text = describeReport(run(referred)).join('\n')
      expect(text).toContain('2 payout(s), 0 paid')
      expect(text).toContain('share  newcomer via ricoref at 400 bp')
      expect(text).toContain('rebate newcomer via ricoref at 400 bp')
      expect(text).toContain('NIM to referrers and')
    })

    it('each M settles its own payout and neither is an unmatched settlement', () => {
      const shareM = send(H.settle, 0, TREASURY, encodeSettlement({ height: H.offer, txIndex: 0, payee: REFERRER_OWNER, amount: NET }))
      const rebateM = send(H.settle, 1, TREASURY, encodeSettlement({ height: H.offer, txIndex: 0, payee: WINNER, amount: NET }))
      const report = run([...referred, shareM, rebateM])
      expect(report.shares).toMatchObject({ settledCount: 2, outstanding: 0n, settled: NET * 2n })
      expect(report.unmatched).toEqual([])
      expect(report.shares?.mispaid).toEqual([])
      expect(isSound(report)).toBe(true)
    })
  })

  // The reading of an outsider: §10.7's format cannot express "no table", so
  // a reader without the operator's rows prices nothing. That used to make
  // every share an `M` that "discharged nothing" — the words for money against
  // no obligation at all. Who was paid and for which registration is in the
  // log; only the amount needed the rows.
  it('a table that prices nothing still recognises the payment, and calls it unpriced', () => {
    const staged = stageLog([...referred, paid], config)
    const collector = createShareCollector(parseRateTable({ rates: [{ ref: null, bp: 0, fromHeight: 0 }] }))
    const replay = replayLog(staged.lines, initialState(), config, LAUNCH_HEIGHT + 720, collector.observe)
    const report = reconcile({ replay, checkpointHeight: LAUNCH_HEIGHT + 720, boundToCheckpoint: true, logHash: '00'.repeat(32), shares: collector.result() })
    expect(report.unmatched).toEqual([])
    expect(report.shares?.unpriced).toHaveLength(1)
    expect(report.shares?.mispaid).toEqual([])
    expect(isSound(report)).toBe(true)
    const text = describeReport(report).join('\n')
    expect(text).toContain('1 referral payment(s) this table does not price')
    expect(text).toContain('newcomer via ricoref')
    expect(text).not.toContain('discharged nothing')
  })

  it('a share paid at the wrong amount is a finding of its own, not an unmatched settlement', () => {
    const short = send(H.settle, 0, TREASURY, encodeSettlement({ height: H.offer, txIndex: 0, payee: REFERRER_OWNER, amount: SHARE - 1n }))
    const report = reportWithShares([...referred, short])
    expect(report.unmatched).toEqual([])
    expect(report.shares?.mispaid).toHaveLength(1)
    expect(report.shares?.standing).toEqual([])
    // The log is still true — the operator paid the wrong figure, which is a
    // different thing from the bytes lying.
    expect(isSound(report)).toBe(true)
    const text = describeReport(report).join('\n')
    expect(text).toContain('DISAGREE with the rate table')
    // Rendered, never computed on: the report prints NIM with five decimals.
    const nim = (luna: bigint): string => `${luna / 100_000n}.${(luna % 100_000n).toString().padStart(5, '0')}`
    expect(text).toContain(`table says ${nim(SHARE)}, paid ${nim(SHARE - 1n)}`)
  })
})

describe('reconcile — a surplus on an OK G is a treasury refund (§10.5, 2026-09-10)', () => {
  it('creates the leg for value − fee, and a treasury M for exactly that settles it', () => {
    const over = [send(H.register, 0, SELLER, encodeRegister({ name: NAME, fee: FEE * 3n }))]
    const owed = reportFor(over)
    expect(owed.lines).toEqual([expect.objectContaining({ owedBy: TREASURY, kind: 'REFUND', created: FEE * 2n, outstanding: FEE * 2n })])
    expect(owed.standing[0]).toMatchObject({ ref: { height: H.register, txIndex: 0 }, owedTo: SELLER, amount: FEE * 2n })
    const paid = reportFor([...over, send(H.settle, 0, TREASURY, encodeSettlement({ height: H.register, txIndex: 0, payee: SELLER, amount: FEE * 2n }))])
    expect(paid.totalOutstanding).toBe(0n)
    expect(paid.unmatched).toEqual([])
    expect(isSound(paid)).toBe(true)
  })
})
