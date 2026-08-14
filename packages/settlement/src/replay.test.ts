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
  refKey,
  type NnsConfig,
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
  testAddress,
  testConfig,
} from './test-fixtures.js'
import { replayLog } from './replay.js'

const NAME = 'alicename'
/** Above `MIN_PRICE` (= `FEE_LONG`), and odd, so `floor` leaves a remainder. */
const PRICE = 50_000_001n
const COMMISSION = commissionOn(PRICE, CONSTANTS.COMMISSION_RATE)
const PROCEEDS = PRICE - COMMISSION

const H = {
  register: LAUNCH_HEIGHT + 10,
  offer: LAUNCH_HEIGHT + 20,
  buy: LAUNCH_HEIGHT + 30,
  settle: LAUNCH_HEIGHT + 40,
} as const

/**
 * One sale, one race loser, and two of the three legs paid.
 *
 * The winning `B` settles as two `M`s (§6 `M`); the loser's refund is left
 * standing so the outstanding side of the report is never empty by accident.
 */
function saleScenario(config: NnsConfig) {
  const fee = feeFor(NAME, initialState(config).prices)
  const floor = minPrice(initialState(config).prices)
  return [
    send(H.register, 0, SELLER, encodeRegister(config, { name: NAME, fee })),
    send(H.offer, 0, SELLER, encodeOffer(config, { name: NAME, price: PRICE, minPrice: floor })),
    // Canonical order decides the race: index 0 wins, index 1 refunds.
    send(H.buy, 0, WINNER, encodeBuy(config, { name: NAME, price: PRICE })),
    send(H.buy, 1, LOSER, encodeBuy(config, { name: NAME, price: PRICE })),
    send(
      H.settle,
      0,
      MARKETPLACE,
      encodeSettlement(config, { height: H.buy, txIndex: 0, payee: SELLER, amount: PROCEEDS }),
    ),
    send(
      H.settle,
      1,
      MARKETPLACE,
      encodeSettlement(config, { height: H.buy, txIndex: 0, payee: TREASURY, amount: COMMISSION }),
    ),
  ]
}

describe('replayLog', () => {
  const config = testConfig()
  const staged = stageLog(saleScenario(config), config)

  it('agrees with every verdict the log carries', () => {
    const result = replayLog(staged.lines, initialState(config), config)
    expect(result.mismatches).toEqual([])
    expect(result.lineCount).toBe(6)
  })

  it('finds the three legs a sale and a race loser create', () => {
    const result = replayLog(staged.lines, initialState(config), config)
    expect(result.created.map((leg) => leg.obligation.kind).sort()).toEqual([
      'COMMISSION',
      'REFUND',
      'SALE_PROCEEDS',
    ])

    const proceeds = result.created.find((leg) => leg.obligation.kind === 'SALE_PROCEEDS')
    expect(proceeds?.obligation.amount).toBe(PROCEEDS)
    expect(proceeds?.obligation.owedTo).toBe(SELLER)
    expect(proceeds?.obligation.owedBy).toBe(MARKETPLACE)

    const commission = result.created.find((leg) => leg.obligation.kind === 'COMMISSION')
    expect(commission?.obligation.amount).toBe(COMMISSION)
    expect(commission?.obligation.owedTo).toBe(TREASURY)

    // The two legs of a sale sum to the price exactly — no dust unaccounted
    // for (§6 `M`).
    expect(PROCEEDS + COMMISSION).toBe(PRICE)
  })

  it('a race loser is refunded in full, never deducted from', () => {
    const result = replayLog(staged.lines, initialState(config), config)
    const refund = result.created.find((leg) => leg.obligation.kind === 'REFUND')
    expect(refund?.obligation.amount).toBe(PRICE)
    expect(refund?.obligation.owedTo).toBe(LOSER)
    expect(refund?.obligation.owedBy).toBe(MARKETPLACE)
  })

  it('matches each M to the leg it discharged', () => {
    const result = replayLog(staged.lines, initialState(config), config)
    expect(result.settled).toHaveLength(2)
    expect(result.settled.map((leg) => leg.obligation.kind).sort()).toEqual(['COMMISSION', 'SALE_PROCEEDS'])
    expect(result.settled.every((leg) => leg.settledAt.height === H.settle)).toBe(true)
  })

  it('leaves the unpaid refund outstanding', () => {
    const result = replayLog(staged.lines, initialState(config), config)
    expect(result.outstanding).toHaveLength(1)
    expect(result.outstanding[0]?.obligation.kind).toBe('REFUND')
    expect(result.outstanding[0]?.obligation.amount).toBe(PRICE)
    expect(refKey(result.outstanding[0]?.obligation.ref ?? { height: 0, txIndex: 0 })).toBe(
      refKey({ height: H.buy, txIndex: 1 }),
    )
  })

  it('created equals settled plus outstanding', () => {
    const result = replayLog(staged.lines, initialState(config), config)
    const total = (legs: readonly { obligation: { amount: bigint } }[]): bigint =>
      legs.reduce((sum, leg) => sum + leg.obligation.amount, 0n)
    expect(total(result.created)).toBe(total(result.settled) + total(result.outstanding))
  })

  it('reaches the same outstanding set the staging run ended on', () => {
    const result = replayLog(staged.lines, initialState(config), config)
    expect([...result.state.outstanding.keys()].sort()).toEqual([...staged.state.outstanding.keys()].sort())
  })

  it('reports an M that discharged nothing, and leaves the debt standing', () => {
    // Same reference, wrong amount: §6 `M` accepts it, it changes nothing, and
    // the refund it failed to pay must still be owed afterwards.
    const withStrayM = stageLog(
      [
        ...saleScenario(config),
        send(
          H.settle + 10,
          0,
          MARKETPLACE,
          encodeSettlement(config, { height: H.buy, txIndex: 1, payee: LOSER, amount: PRICE - 1n }),
        ),
      ],
      config,
    )
    const result = replayLog(withStrayM.lines, initialState(config), config)

    expect(result.unmatched).toHaveLength(1)
    expect(result.unmatched[0]?.value).toBe(PRICE - 1n)
    expect(result.unmatched[0]?.claims).toEqual({ height: H.buy, txIndex: 1 })
    expect(result.outstanding).toHaveLength(1)
    expect(result.outstanding[0]?.obligation.amount).toBe(PRICE)
    expect(result.mismatches).toEqual([])
  })

  it('catches a log whose verdict is not the one the rules derive', () => {
    // The line is otherwise untouched: only the token is rewritten, which is
    // the tamper a reconciler that trusted the token would never see.
    const tampered = staged.lines.map((line, index) =>
      index === 3 ? line.replace(/ OFFER_NOT_OPEN$/, ' OK') : line,
    )
    expect(tampered[3]).not.toBe(staged.lines[3])

    const result = replayLog(tampered, initialState(config), config)
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]).toMatchObject({
      at: { height: H.buy, txIndex: 1 },
      logged: 'OK',
      replayed: 'OFFER_NOT_OPEN',
    })
  })

  it('a different reserved list shows up as a verdict disagreement, not a silent skew', () => {
    const reserved = stageLog(saleScenario(testConfig({ reservedNames: [NAME] })), testConfig({ reservedNames: [NAME] }))
    const result = replayLog(reserved.lines, initialState(config), config)
    // Staged as RESERVED_NAME, replayed under a list that does not hold the
    // name — the reconciler must say so rather than quietly reconcile to zero.
    expect(result.mismatches.length).toBeGreaterThan(0)
  })

  it('refuses a log that is out of canonical order', () => {
    const reordered = [staged.lines[1], staged.lines[0], ...staged.lines.slice(2)] as string[]
    expect(() => replayLog(reordered, initialState(config), config)).toThrow(/not in canonical order/)
  })

  it('refuses a line that is not a canonical §8.2 line', () => {
    expect(() => replayLog(['1000 0 deadbeef'], initialState(config), config)).toThrow(/not a canonical/)
  })

  it('an empty log reconciles to nothing owed', () => {
    const result = replayLog([], initialState(config), config)
    expect(result.created).toEqual([])
    expect(result.settled).toEqual([])
    expect(result.outstanding).toEqual([])
    expect(result.lastLineHeight).toBeNull()
  })

  it('a forfeited registration creates no obligation', () => {
    // Underfunded: §7.4 puts INSUFFICIENT_VALUE in the forfeit column, so the
    // value is not recoverable and nothing is owed.
    const underfunded = stageLog(
      [send(H.register, 0, SELLER, { recipient: TREASURY, value: 1n, data: encodeRegister(config, { name: NAME, fee: feeFor(NAME, initialState(config).prices) }).data })],
      config,
    )
    const result = replayLog(underfunded.lines, initialState(config), config)
    expect(result.mismatches).toEqual([])
    expect(result.created).toEqual([])
    expect(result.outstanding).toEqual([])
  })

  it('a G that loses a registration race is owed by the treasury, not the marketplace', () => {
    const fee = feeFor(NAME, initialState(config).prices)
    const race = stageLog(
      [
        send(H.register, 0, SELLER, encodeRegister(config, { name: NAME, fee })),
        send(H.register, 1, testAddress(20), encodeRegister(config, { name: NAME, fee })),
      ],
      config,
    )
    const result = replayLog(race.lines, initialState(config), config)
    expect(result.created).toHaveLength(1)
    expect(result.created[0]?.obligation.kind).toBe('REFUND')
    expect(result.created[0]?.obligation.owedBy).toBe(TREASURY)
    expect(result.created[0]?.obligation.amount).toBe(fee)
  })
})
