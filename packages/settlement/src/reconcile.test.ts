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
} from '@nns/core'

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
import { replayLog } from './replay.js'

const NAME = 'alicename'
const PRICE = 50_000_001n
const COMMISSION = commissionOn(PRICE, CONSTANTS.COMMISSION_RATE)
const PROCEEDS = PRICE - COMMISSION

const config = testConfig()
const FEE = feeFor(NAME, initialState(config).prices)
const FLOOR = minPrice(initialState(config).prices)

const H = { register: LAUNCH_HEIGHT + 10, offer: LAUNCH_HEIGHT + 20, buy: LAUNCH_HEIGHT + 30, settle: LAUNCH_HEIGHT + 40 }

const scenario = [
  send(H.register, 0, SELLER, encodeRegister(config, { name: NAME, fee: FEE })),
  send(H.offer, 0, SELLER, encodeOffer(config, { name: NAME, price: PRICE, minPrice: FLOOR })),
  send(H.buy, 0, WINNER, encodeBuy(config, { name: NAME, price: PRICE })),
  send(H.buy, 1, LOSER, encodeBuy(config, { name: NAME, price: PRICE })),
  send(H.settle, 0, MARKETPLACE, encodeSettlement(config, { height: H.buy, txIndex: 0, payee: SELLER, amount: PROCEEDS })),
]

function reportFor(sends: typeof scenario, boundToCheckpoint = true) {
  const staged = stageLog(sends, config)
  const replay = replayLog(staged.lines, initialState(config), config)
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

  it('ages each standing obligation against the end of the log', () => {
    const report = reportFor(scenario)
    const refund = report.standing.find((leg) => leg.kind === 'REFUND')
    expect(refund?.ageBlocks).toBe(H.settle - H.buy)
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
    const replay = replayLog(tampered, initialState(config), config)
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
    // 50,000,001 luna is 500.00001 NIM — the fractional digits are the point.
    expect(text).toContain('500.00001')
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
        encodeSettlement(config, { height: H.buy, txIndex: 1, payee: LOSER, amount: 1n }),
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
        encodeSettlement(config, { height: H.buy, txIndex: 0, payee: TREASURY, amount: COMMISSION }),
      ),
      send(
        H.settle,
        2,
        MARKETPLACE,
        encodeSettlement(config, { height: H.buy, txIndex: 1, payee: LOSER, amount: PRICE }),
      ),
    ]
    const report = reportFor(settled)
    expect(report.totalOutstanding).toBe(0n)
    expect(report.totalSettled).toBe(report.totalCreated)
    expect(report.standing).toEqual([])
    expect(isSound(report)).toBe(true)
  })
})
