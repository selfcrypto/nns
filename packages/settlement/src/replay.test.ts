import { describe, expect, it } from 'vitest'

import {
  advanceTo,
  CONSTANTS,
  commissionOn,
  encodeAuction,
  encodeBuy,
  encodeOffer,
  encodeRegister,
  encodeSettlement,
  feeFor,
  initialState,
  minPrice,
  refKey,
  type NnsConfig,
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
  testAddress,
  testConfig,
} from './test-fixtures.js'
import { replayLog } from './replay.js'

/** The checkpoint every scenario below is served through — above its last line. */
const HEAD = LAUNCH_HEIGHT + 100

const NAME = 'alicename'
/** Above `MIN_PRICE` (= `FEE_BASE`), and odd, so `floor` leaves a remainder. */
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
  const fee = feeFor(NAME, initialState().prices)
  const floor = minPrice(initialState().prices)
  return [
    send(H.register, 0, SELLER, encodeRegister({ name: NAME, fee })),
    send(H.offer, 0, SELLER, encodeOffer({ name: NAME, price: PRICE, minPrice: floor })),
    // Canonical order decides the race: index 0 wins, index 1 refunds.
    send(H.buy, 0, WINNER, encodeBuy({ name: NAME, price: PRICE })),
    send(H.buy, 1, LOSER, encodeBuy({ name: NAME, price: PRICE })),
    send(
      H.settle,
      0,
      MARKETPLACE,
      encodeSettlement({ height: H.buy, txIndex: 0, payee: SELLER, amount: PROCEEDS }),
    ),
    send(
      H.settle,
      1,
      MARKETPLACE,
      encodeSettlement({ height: H.buy, txIndex: 0, payee: TREASURY, amount: COMMISSION }),
    ),
  ]
}

describe('replayLog', () => {
  const config = testConfig()
  const staged = stageLog(saleScenario(config), config)

  it('agrees with every verdict the log carries', () => {
    const result = replayLog(staged.lines, initialState(), config, HEAD)
    expect(result.mismatches).toEqual([])
    expect(result.lineCount).toBe(6)
  })

  it('finds the three legs a sale and a race loser create', () => {
    const result = replayLog(staged.lines, initialState(), config, HEAD)
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
    const result = replayLog(staged.lines, initialState(), config, HEAD)
    const refund = result.created.find((leg) => leg.obligation.kind === 'REFUND')
    expect(refund?.obligation.amount).toBe(PRICE)
    expect(refund?.obligation.owedTo).toBe(LOSER)
    expect(refund?.obligation.owedBy).toBe(MARKETPLACE)
  })

  it('matches each M to the leg it discharged', () => {
    const result = replayLog(staged.lines, initialState(), config, HEAD)
    expect(result.settled).toHaveLength(2)
    expect(result.settled.map((leg) => leg.obligation.kind).sort()).toEqual(['COMMISSION', 'SALE_PROCEEDS'])
    expect(result.settled.every((leg) => leg.settledAt.height === H.settle)).toBe(true)
  })

  it('leaves the unpaid refund outstanding', () => {
    const result = replayLog(staged.lines, initialState(), config, HEAD)
    expect(result.outstanding).toHaveLength(1)
    expect(result.outstanding[0]?.obligation.kind).toBe('REFUND')
    expect(result.outstanding[0]?.obligation.amount).toBe(PRICE)
    expect(refKey(result.outstanding[0]?.obligation.ref ?? { height: 0, txIndex: 0 })).toBe(
      refKey({ height: H.buy, txIndex: 1 }),
    )
  })

  it('created equals settled plus outstanding', () => {
    const result = replayLog(staged.lines, initialState(), config, HEAD)
    const total = (legs: readonly { obligation: { amount: bigint } }[]): bigint =>
      legs.reduce((sum, leg) => sum + leg.obligation.amount, 0n)
    expect(total(result.created)).toBe(total(result.settled) + total(result.outstanding))
  })

  it('reaches the same outstanding set the staging run ended on', () => {
    const result = replayLog(staged.lines, initialState(), config, HEAD)
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
          encodeSettlement({ height: H.buy, txIndex: 1, payee: LOSER, amount: PRICE - 1n }),
        ),
      ],
      config,
    )
    const result = replayLog(withStrayM.lines, initialState(), config, HEAD)

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

    const result = replayLog(tampered, initialState(), config, HEAD)
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]).toMatchObject({
      at: { height: H.buy, txIndex: 1 },
      logged: 'OK',
      replayed: 'OFFER_NOT_OPEN',
    })
  })

  it('catches the verdict a divergent reserved list would have produced', () => {
    // RESERVED_NAMES is a §3 constant since the launch freeze, so two honest
    // replays can no longer disagree about it — the wrong-list scenario this
    // test used to stage is unreachable by configuration. What is still
    // reachable is a log claiming the verdict a divergent list *would* have
    // produced: a `G` on a reserved name logged as OK. That must be a loud
    // disagreement rather than a quietly different total.
    const reservedName = 'binance'
    const fee = feeFor(reservedName, initialState().prices)
    const held = stageLog(
      [send(H.register, 0, SELLER, encodeRegister({ name: reservedName, fee }))],
      config,
    )
    expect(held.lines[0]).toMatch(/ RESERVED_NAME$/)
    expect(replayLog(held.lines, initialState(), config, HEAD).mismatches).toEqual([])

    const tampered = held.lines.map((line) => line.replace(/ RESERVED_NAME$/, ' OK'))
    const result = replayLog(tampered, initialState(), config, HEAD)
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]).toMatchObject({ logged: 'OK', replayed: 'RESERVED_NAME' })
  })

  it('refuses a log that is out of canonical order', () => {
    const reordered = [staged.lines[1], staged.lines[0], ...staged.lines.slice(2)] as string[]
    expect(() => replayLog(reordered, initialState(), config, HEAD)).toThrow(/not in canonical order/)
  })

  it('refuses a line that is not a canonical §8.2 line', () => {
    expect(() => replayLog(['1000 0 deadbeef'], initialState(), config, HEAD)).toThrow(/not a canonical/)
  })

  it('an empty log reconciles to nothing owed', () => {
    const result = replayLog([], initialState(), config, HEAD)
    expect(result.created).toEqual([])
    expect(result.settled).toEqual([])
    expect(result.outstanding).toEqual([])
    expect(result.lastLineHeight).toBeNull()
  })

  it('a forfeited registration creates no obligation', () => {
    // One luna against a 2,000 NIM band: an underpayment is a refund since
    // r29, but REFUND_FLOOR turns one this small into a forfeit, so nothing
    // is owed.
    const underfunded = stageLog(
      [send(H.register, 0, SELLER, { recipient: TREASURY, value: 1n, data: encodeRegister({ name: NAME, fee: feeFor(NAME, initialState().prices) }).data })],
      config,
    )
    const result = replayLog(underfunded.lines, initialState(), config, HEAD)
    expect(result.mismatches).toEqual([])
    expect(result.created).toEqual([])
    expect(result.outstanding).toEqual([])
  })

  it('an underpaid G at or above REFUND_FLOOR is owed back by the treasury (r29)', () => {
    const short = feeFor(NAME, initialState().prices) - 1n
    const underpaid = stageLog(
      [send(H.register, 0, SELLER, { recipient: TREASURY, value: short, data: encodeRegister({ name: NAME, fee: feeFor(NAME, initialState().prices) }).data })],
      config,
    )
    const result = replayLog(underpaid.lines, initialState(), config, HEAD)
    expect(result.mismatches).toEqual([])
    expect(result.created).toHaveLength(1)
    expect(result.created[0]?.obligation).toMatchObject({ kind: 'REFUND', owedBy: TREASURY, owedTo: SELLER, amount: short })
  })

  it('a lifetime G derives its surplus and its underpayment from the lifetime fee, with no code of its own (2026-09-11)', () => {
    // §10.4: `|L` owes LIFETIME_MULTIPLIER yearly fees. The replay learns
    // nothing new — `feeFor` is the reducer's, and the legs fall out of it.
    const lifetime = feeFor(NAME, initialState().prices, true)
    expect(lifetime).toBe(feeFor(NAME, initialState().prices) * CONSTANTS.LIFETIME_MULTIPLIER)
    const payload = encodeRegister({ name: NAME, fee: lifetime, lifetime: true }).data
    // A surplus of exactly REFUND_FLOOR — the smallest one refunded (§10.5).
    const over = stageLog([send(H.register, 0, SELLER, { recipient: TREASURY, value: lifetime + CONSTANTS.REFUND_FLOOR, data: payload })], config)
    const surplus = replayLog(over.lines, initialState(), config, HEAD)
    expect(surplus.mismatches).toEqual([])
    expect(surplus.created).toHaveLength(1)
    expect(surplus.created[0]?.obligation).toMatchObject({ kind: 'REFUND', owedBy: TREASURY, owedTo: SELLER, amount: CONSTANTS.REFUND_FLOOR })
    // Ten yearly fees less one luna: short of the lifetime fee, refunded whole.
    const under = stageLog([send(H.register, 0, SELLER, { recipient: TREASURY, value: lifetime - 1n, data: payload })], config)
    const refund = replayLog(under.lines, initialState(), config, HEAD)
    expect(refund.mismatches).toEqual([])
    expect(refund.created[0]?.obligation).toMatchObject({ kind: 'REFUND', owedBy: TREASURY, owedTo: SELLER, amount: lifetime - 1n })
  })

  it('a G that loses a registration race is owed by the treasury, not the marketplace', () => {
    const fee = feeFor(NAME, initialState().prices)
    const race = stageLog(
      [
        send(H.register, 0, SELLER, encodeRegister({ name: NAME, fee })),
        send(H.register, 1, testAddress(20), encodeRegister({ name: NAME, fee })),
      ],
      config,
    )
    const result = replayLog(race.lines, initialState(), config, HEAD)
    expect(result.created).toHaveLength(1)
    expect(result.created[0]?.obligation.kind).toBe('REFUND')
    expect(result.created[0]?.obligation.owedBy).toBe(TREASURY)
    expect(result.created[0]?.obligation.amount).toBe(fee)
  })
})

/**
 * r28: the legs an auction creates, and where the replay first sees each.
 *
 * Two of them have no verdict to carry them — the close is a height effect —
 * so these tests are the reason the replay diffs `outstanding` instead of
 * reading `Verdict.obligations`, and the reason it advances to the checkpoint
 * height rather than to the last line.
 */
describe('replayLog — auctions (r28)', () => {
  const config = testConfig()
  const STARTING_PRICE = PRICE
  const UNDERBIDDER = testAddress(13)
  const HA = {
    register: LAUNCH_HEIGHT + 10,
    open: LAUNCH_HEIGHT + 20,
    first: LAUNCH_HEIGHT + 30,
    outbid: LAUNCH_HEIGHT + 31,
    low: LAUNCH_HEIGHT + 32,
  } as const
  const END = HA.open + CONSTANTS.AUCTION_MIN_DURATION
  /** `standing + ⌊standing × AUCTION_MIN_INCREMENT⌋` (§6 `A`), computed the way core does. */
  const WINNING = STARTING_PRICE + commissionOn(STARTING_PRICE, CONSTANTS.AUCTION_MIN_INCREMENT_BP)
  const CLOSE_COMMISSION = commissionOn(WINNING, CONSTANTS.COMMISSION_RATE)
  const FIRST_REF = { height: HA.first, txIndex: 0 }
  const WINNING_REF = { height: HA.outbid, txIndex: 0 }
  const LOW_REF = { height: HA.low, txIndex: 0 }

  function auctionScenario() {
    const fee = feeFor(NAME, initialState().prices)
    const floor = minPrice(initialState().prices)
    return [
      send(HA.register, 0, SELLER, encodeRegister({ name: NAME, fee })),
      send(HA.open, 0, SELLER, encodeAuction({ name: NAME, startingPrice: STARTING_PRICE, endHeight: END, minPrice: floor })),
      send(HA.first, 0, LOSER, encodeBuy({ name: NAME, price: STARTING_PRICE })),
      send(HA.outbid, 0, WINNER, encodeBuy({ name: NAME, price: WINNING })),
      // Below the standing bid's increment: refunded under WRONG_PRICE.
      send(HA.low, 0, UNDERBIDDER, encodeBuy({ name: NAME, price: STARTING_PRICE })),
    ]
  }
  const staged = stageLog(auctionScenario(), config)
  const kindsAt = (legs: readonly { obligation: { ref: { height: number; txIndex: number }; kind: string } }[], ref: { height: number; txIndex: number }) =>
    legs.filter((leg) => refKey(leg.obligation.ref) === refKey(ref)).map((leg) => leg.obligation.kind).sort()

  it('agrees with every verdict, and the outbid refund is keyed by the outbid bid and surfaced by the outbidding one', () => {
    const result = replayLog(staged.lines, initialState(), config, END - 1)
    expect(result.mismatches).toEqual([])
    expect(staged.lines[3]).toMatch(/ OK$/)
    expect(staged.lines[4]).toMatch(/ WRONG_PRICE$/)

    expect(result.created).toHaveLength(2)
    const outbid = result.created.find((leg) => refKey(leg.obligation.ref) === refKey(FIRST_REF))
    expect(outbid?.obligation).toMatchObject({ kind: 'REFUND', owedBy: MARKETPLACE, owedTo: LOSER, amount: STARTING_PRICE })
    expect(outbid?.at).toEqual(WINNING_REF)

    const low = result.created.find((leg) => refKey(leg.obligation.ref) === refKey(LOW_REF))
    expect(low?.obligation).toMatchObject({ kind: 'REFUND', owedTo: UNDERBIDDER, amount: STARTING_PRICE })
    expect(low?.at).toEqual(LOW_REF)

    // Not closed yet: the auction stands, the name is still the seller's.
    expect(result.state.auctions.get(NAME)?.bidder).toBe(WINNER)
    expect(result.state.names.get(NAME)?.owner).toBe(SELLER)
    expect(kindsAt(result.outstanding, WINNING_REF)).toEqual([])
  })

  it('surfaces the close from the final advance when no line follows it', () => {
    const result = replayLog(staged.lines, initialState(), config, END)
    expect(result.mismatches).toEqual([])
    expect(result.lastLineHeight).toBe(HA.low)
    expect(result.state.height).toBe(END)

    expect(result.created).toHaveLength(4)
    expect(kindsAt(result.created, WINNING_REF)).toEqual(['COMMISSION', 'SALE_PROCEEDS'])
    const proceeds = result.created.find((leg) => leg.obligation.kind === 'SALE_PROCEEDS')
    expect(proceeds?.obligation).toMatchObject({ owedBy: MARKETPLACE, owedTo: SELLER, amount: WINNING - CLOSE_COMMISSION })
    expect(proceeds?.at).toBeNull()
    const commission = result.created.find((leg) => leg.obligation.kind === 'COMMISSION')
    expect(commission?.obligation).toMatchObject({ owedBy: MARKETPLACE, owedTo: TREASURY, amount: CLOSE_COMMISSION })
    expect(commission?.at).toBeNull()

    expect(result.state.auctions.size).toBe(0)
    expect(result.state.names.get(NAME)?.owner).toBe(WINNER)
    expect(result.outstanding).toHaveLength(4)
    expect(result.settled).toEqual([])

    // The same answer the indexer reaches: its checkpoint state is advanced
    // to the boundary too.
    expect([...result.state.outstanding.keys()].sort()).toEqual(
      [...advanceTo(staged.state, END).outstanding.keys()].sort(),
    )
  })

  it('surfaces the close on the first line past it, and lets an M discharge a close leg', () => {
    const paid = stageLog(
      [
        ...auctionScenario(),
        send(
          END + 10,
          0,
          MARKETPLACE,
          encodeSettlement({ height: HA.outbid, txIndex: 0, payee: SELLER, amount: WINNING - CLOSE_COMMISSION }),
        ),
      ],
      config,
    )
    expect(paid.lines[5]).toMatch(/ OK$/)
    const result = replayLog(paid.lines, initialState(), config, END + 10)
    expect(result.mismatches).toEqual([])
    const proceeds = result.created.find((leg) => leg.obligation.kind === 'SALE_PROCEEDS')
    expect(proceeds?.at).toEqual({ height: END + 10, txIndex: 0 })
    expect(result.settled.map((leg) => leg.obligation.kind)).toEqual(['SALE_PROCEEDS'])
    expect(result.outstanding.map((leg) => leg.obligation.kind).sort()).toEqual(['COMMISSION', 'REFUND', 'REFUND'])
    expect(result.unmatched).toEqual([])
  })

  it('an auction with no bid closes owing nothing', () => {
    const unbid = stageLog(auctionScenario().slice(0, 2), config)
    const result = replayLog(unbid.lines, initialState(), config, END)
    expect(result.created).toEqual([])
    expect(result.state.auctions.size).toBe(0)
    expect(result.state.names.get(NAME)?.owner).toBe(SELLER)
  })

  it('the grace reset cancels a running auction and refunds the standing bid, with no line to say so', () => {
    // An A cannot open past the term (AUCTION_BEYOND_TERM, 2026-09-03), so
    // the end is carried onto the expiry by a bid landing exactly
    // AUCTION_EXTENSION before it; §7.3 fires the expiry first and the reset
    // cancels the auction with a refund — a leg with no line behind it.
    const expiry = HA.register + CONSTANTS.TERM_LENGTH
    const open = expiry - CONSTANTS.AUCTION_MIN_DURATION - 5
    const bid = expiry - CONSTANTS.AUCTION_EXTENSION
    const fee = feeFor(NAME, initialState().prices)
    const floor = minPrice(initialState().prices)
    const late = stageLog(
      [
        send(HA.register, 0, SELLER, encodeRegister({ name: NAME, fee })),
        send(open, 0, SELLER, encodeAuction({ name: NAME, startingPrice: STARTING_PRICE, endHeight: expiry - 1, minPrice: floor })),
        send(bid, 0, WINNER, encodeBuy({ name: NAME, price: STARTING_PRICE })),
      ],
      config,
    )
    expect(late.lines.map((line) => line.split(' ').at(-1))).toEqual(['OK', 'OK', 'OK'])

    const before = replayLog(late.lines, initialState(), config, expiry - 1)
    expect(before.created).toEqual([])

    const result = replayLog(late.lines, initialState(), config, expiry)
    expect(result.created).toHaveLength(1)
    expect(result.created[0]?.obligation).toMatchObject({
      ref: { height: bid, txIndex: 0 },
      kind: 'REFUND',
      owedBy: MARKETPLACE,
      owedTo: WINNER,
      amount: STARTING_PRICE,
    })
    expect(result.created[0]?.at).toBeNull()
    expect(result.state.auctions.size).toBe(0)
    expect(result.state.names.get(NAME)).toMatchObject({ owner: SELLER, status: 'GRACE' })
  })

  it('refuses a log served through a checkpoint below its own last line', () => {
    expect(() => replayLog(staged.lines, initialState(), config, HA.low - 1)).toThrow(/above the checkpoint height/)
  })
})
