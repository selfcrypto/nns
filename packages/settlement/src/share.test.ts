import { describe, expect, it } from 'vitest'

import { CONSTANTS, encodeRegister, encodeSettlement, feeFor, initialState, refKey, type NnsState } from '@nns/core'

import { LAUNCH_HEIGHT, TREASURY, WINNER, send, stageLog, testAddress, testConfig, type Send } from './test-fixtures.js'
import { parseRateTable } from './rates.js'
import { replayLog } from './replay.js'
import { createShareCollector, explainedSettlements, NO_SHARES, referralOf, SHARE_KIND, shareKey, shareOwed } from './share.js'

const config = testConfig()
const REFERRER_OWNER = testAddress(20)
const REFERRER = 'ricoref'
const NEWCOMER = 'newcomer'
const FEE = (name: string): bigint => feeFor(name, initialState().prices)

const DEFAULT = parseRateTable({ rates: [{ ref: null, bp: 1000, fromHeight: 0 }] })

const H = {
  referrer: LAUNCH_HEIGHT + 10,
  register: LAUNCH_HEIGHT + 20,
  settle: LAUNCH_HEIGHT + 30,
} as const
const THROUGH = LAUNCH_HEIGHT + CONSTANTS.CHECKPOINT_INTERVAL

const referrerRegistered = send(H.referrer, 0, REFERRER_OWNER, encodeRegister({ name: REFERRER, fee: FEE(REFERRER) }))
const referred = (extra: Partial<{ fee: bigint; ref: string; height: number; lifetime: boolean }> = {}) =>
  send(
    extra.height ?? H.register,
    0,
    WINNER,
    encodeRegister({
      name: NEWCOMER,
      fee: extra.fee ?? feeFor(NEWCOMER, initialState().prices, extra.lifetime ?? false),
      ref: extra.ref ?? REFERRER,
      ...(extra.lifetime ? { lifetime: true } : {}),
    }),
  )

function collect(sends: readonly Send[], table = DEFAULT, through = THROUGH) {
  const staged = stageLog(sends, config)
  const collector = createShareCollector(table)
  const replay = replayLog(staged.lines, initialState(), config, through, collector.observe)
  return { replay, shares: collector.result() }
}

const SHARE = (FEE(NEWCOMER) * 1000n) / 10_000n

describe('shareOwed — §10.7 in one function', () => {
  it('owes the referrer’s target ⌊price × rate⌋ on an OK G that names a registered ref', () => {
    const { shares } = collect([referrerRegistered, referred()])
    expect(shares.created).toHaveLength(1)
    const leg = shares.created[0]!
    expect(leg).toMatchObject({
      ref: { height: H.register, txIndex: 0 },
      name: NEWCOMER,
      referrer: REFERRER,
      owedBy: TREASURY,
      owedTo: REFERRER_OWNER,
      amount: SHARE,
      price: FEE(NEWCOMER),
      rateBp: 1000n,
    })
    expect(shares.outstanding).toEqual(shares.created)
    expect(shareKey(leg)).toBe(`${H.register}:0:${SHARE_KIND}`)
  })

  it('is on the fee in effect, never the value sent — an overpayment farms nothing', () => {
    const { shares } = collect([referrerRegistered, referred({ fee: FEE(NEWCOMER) * 5n })])
    expect(shares.created[0]?.amount).toBe(SHARE)
  })

  it('a lifetime G owes one share of the lifetime fee (2026-09-11)', () => {
    // The fee owed is what the reducer checked the value against; a `G|L`
    // pays LIFETIME_MULTIPLIER yearly fees at once, and the share is the rate
    // on what was paid at the moment the link was used — once, and never
    // again, since `N` carries no ref (Kike, 2026-09-12).
    const { replay, shares } = collect([referrerRegistered, referred({ lifetime: true })])
    expect(replay.mismatches).toEqual([])
    const lifetimeFee = feeFor(NEWCOMER, initialState().prices, true)
    expect(lifetimeFee).toBe(FEE(NEWCOMER) * CONSTANTS.LIFETIME_MULTIPLIER)
    expect(shares.created[0]).toMatchObject({ price: lifetimeFee, amount: SHARE * CONSTANTS.LIFETIME_MULTIPLIER })
  })

  it('owes nothing when the ref is not registered', () => {
    const { shares } = collect([referred({ ref: 'nobodyhere' })])
    expect(shares.created).toEqual([])
  })

  it('owes nothing when the G refers to the name it registers — the name does not exist yet', () => {
    const self = send(H.register, 0, WINNER, encodeRegister({ name: NEWCOMER, fee: FEE(NEWCOMER), ref: NEWCOMER }))
    const { shares } = collect([self])
    expect(shares.created).toEqual([])
  })

  it('owes nothing when the ref is in GRACE at the G’s position (§7.3)', () => {
    const expiry = H.referrer + CONSTANTS.TERM_LENGTH
    const { shares } = collect([referrerRegistered, referred({ height: expiry })], DEFAULT, expiry + 1)
    expect(shares.created).toEqual([])
    // One block earlier it still resolves, and still refers.
    const before = collect([referrerRegistered, referred({ height: expiry - 1 })], DEFAULT, expiry + 1)
    expect(before.shares.created).toHaveLength(1)
  })

  it('owes nothing on a G that was not OK — it registered nothing', () => {
    const { shares } = collect([referrerRegistered, referred({ fee: FEE(NEWCOMER) - 1n })])
    expect(shares.created).toEqual([])
  })

  it('takes the rate row in effect at the G’s height, exact ref before default', () => {
    const table = parseRateTable({
      rates: [
        { ref: null, bp: 1000, fromHeight: 0 },
        { ref: REFERRER, bp: 2500, fromHeight: H.register + 1 },
      ],
    })
    const early = collect([referrerRegistered, referred()], table)
    expect(early.shares.created[0]?.rateBp).toBe(1000n)
    const late = collect([referrerRegistered, referred({ height: H.register + 1 })], table)
    expect(late.shares.created[0]?.rateBp).toBe(2500n)
    expect(late.shares.created[0]?.amount).toBe((FEE(NEWCOMER) * 2500n) / 10_000n)
  })

  it('owes nothing at a zero rate', () => {
    const zero = parseRateTable({ rates: [{ ref: null, bp: 0, fromHeight: 0 }] })
    expect(collect([referrerRegistered, referred()], zero).shares.created).toEqual([])
  })

  it('is pure over the state it is handed', () => {
    const staged = stageLog([referrerRegistered], config)
    const before: NnsState = staged.state
    const tx = {
      blockNumber: H.register,
      txIndex: 0,
      hash: 'ab'.repeat(32),
      sender: WINNER,
      recipient: TREASURY,
      value: FEE(NEWCOMER),
      recipientData: encodeRegister({ name: NEWCOMER, fee: FEE(NEWCOMER), ref: REFERRER }).data,
      executionResult: true,
      networkId: config.networkId,
      isReward: false,
    }
    const leg = shareOwed(before, tx, { height: H.register, txIndex: 0 }, { kind: 'OK', obligations: [] }, DEFAULT)
    expect(leg?.amount).toBe(SHARE)
    expect(shareOwed(before, tx, { height: H.register, txIndex: 0 }, { kind: 'FORFEIT', reason: 'RESERVED_NAME' }, DEFAULT)).toBeNull()
  })
})

describe('the share is settled by a treasury M with the four coordinates (§6 M)', () => {
  const paid = send(H.settle, 0, TREASURY, encodeSettlement({ height: H.register, txIndex: 0, payee: REFERRER_OWNER, amount: SHARE }))

  it('matches the M and moves the leg from outstanding to settled', () => {
    const { replay, shares } = collect([referrerRegistered, referred(), paid])
    expect(shares.settled).toHaveLength(1)
    expect(shares.settled[0]).toMatchObject({ settledAt: { height: H.settle, txIndex: 0 } })
    expect(shares.outstanding).toEqual([])
    // The reducer saw the same M as OK and discharging nothing — by design.
    expect(replay.unmatched).toHaveLength(1)
    expect(replay.unmatched[0]?.at).toEqual({ height: H.settle, txIndex: 0 })
  })

  it('a wrong payee or purse settles nothing, and is this referral’s payment in no sense', () => {
    const wrongPayee = send(H.settle, 0, TREASURY, encodeSettlement({ height: H.register, txIndex: 0, payee: WINNER, amount: SHARE }))
    const other = collect([referrerRegistered, referred(), wrongPayee]).shares
    expect(other.outstanding).toHaveLength(1)
    expect([...other.settled, ...other.unpriced, ...other.mispaid]).toEqual([])
    const wrongPurse = send(H.settle, 0, CONSTANTS.MARKETPLACE_ADDRESS, encodeSettlement({ height: H.register, txIndex: 0, payee: REFERRER_OWNER, amount: SHARE }))
    const purse = collect([referrerRegistered, referred(), wrongPurse]).shares
    expect(purse.outstanding).toHaveLength(1)
    expect([...purse.settled, ...purse.unpriced, ...purse.mispaid]).toEqual([])
  })

  it('the right payee for the wrong amount is MISPAID, not still owed', () => {
    // Money left the treasury to the right person for this registration. The
    // debt is not "standing" — it was paid, at a figure the table disagrees
    // with — and topping it up automatically would pay a second time on a
    // repriced row. A human decides.
    const short = send(H.settle, 0, TREASURY, encodeSettlement({ height: H.register, txIndex: 0, payee: REFERRER_OWNER, amount: SHARE - 1n }))
    const { shares } = collect([referrerRegistered, referred(), short])
    expect(shares.outstanding).toEqual([])
    expect(shares.settled).toEqual([])
    expect(shares.mispaid).toHaveLength(1)
    expect(shares.mispaid[0]).toMatchObject({
      paidAt: { height: H.settle, txIndex: 0 },
      paid: SHARE - 1n,
      leg: { ref: { height: H.register, txIndex: 0 }, amount: SHARE, referrer: REFERRER },
    })
  })

  // A referrer's target registers a second name through its own link and
  // overpays: the treasury owes that one address a refund (a reducer leg) and
  // a share (this ledger) on the same `G`. Only the reducer says which `M`
  // was the refund, and it must be asked — the old four-coordinate match
  // never took the refund because its amount differed, and a match that
  // classifies by amount would take it as a mispaid share and leave the real
  // share as money against nothing.
  for (const [label, order] of [
    ['refund first', ['refund', 'share']],
    ['share first', ['share', 'refund']],
  ] as const) {
    it(`a refund and a share to one payee for one G, ${label}: each M settles its own debt`, () => {
      const surplus = FEE(NEWCOMER)
      const self = send(H.register, 0, REFERRER_OWNER, encodeRegister({ name: NEWCOMER, fee: FEE(NEWCOMER) + surplus, ref: REFERRER }))
      const m = {
        refund: encodeSettlement({ height: H.register, txIndex: 0, payee: REFERRER_OWNER, amount: surplus }),
        share: encodeSettlement({ height: H.register, txIndex: 0, payee: REFERRER_OWNER, amount: SHARE }),
      }
      const { replay, shares } = collect([referrerRegistered, self, ...order.map((which, i) => send(H.settle, i, TREASURY, m[which]))])
      expect(replay.mismatches).toEqual([])
      expect(replay.settled.map((item) => item.obligation.kind)).toEqual(['REFUND'])
      expect(replay.unmatched).toHaveLength(1)
      expect(shares.settled).toHaveLength(1)
      expect(shares.settled[0]?.settledAt).toEqual({ height: H.settle, txIndex: order.indexOf('share') })
      expect(shares.mispaid).toEqual([])
      expect(shares.outstanding).toEqual([])
      expect(explainedSettlements(shares).has(refKey(replay.unmatched[0]!.at))).toBe(true)
    })
  }

  it('a second identical M settles nothing — the leg is already paid', () => {
    const again = send(H.settle, 1, TREASURY, encodeSettlement({ height: H.register, txIndex: 0, payee: REFERRER_OWNER, amount: SHARE }))
    const { shares } = collect([referrerRegistered, referred(), paid, again])
    expect(shares.settled).toHaveLength(1)
  })
})

describe('a referral payment is recognised from the log, and priced by the table', () => {
  const paid = send(H.settle, 0, TREASURY, encodeSettlement({ height: H.register, txIndex: 0, payee: REFERRER_OWNER, amount: SHARE }))
  // The two ways a table says "I have no rate here". §10.7's format cannot
  // express an absent table — `parseRateTable` requires a default row — so
  // this is how a reader without the operator's rows actually reads a log.
  const zero = parseRateTable({ rates: [{ ref: null, bp: 0, fromHeight: 0 }] })
  const notYet = parseRateTable({ rates: [{ ref: null, bp: 1000, fromHeight: H.settle + 1 }] })

  for (const [label, table] of [['a zero rate', zero], ['no row in effect yet', notYet]] as const) {
    it(`with ${label}: the payment is UNPRICED — who and for what, without the amount`, () => {
      const { replay, shares } = collect([referrerRegistered, referred(), paid], table)
      expect(shares.created).toEqual([])
      expect(shares.outstanding).toEqual([])
      expect(shares.settled).toEqual([])
      expect(shares.mispaid).toEqual([])
      expect(shares.unpriced).toHaveLength(1)
      expect(shares.unpriced[0]).toMatchObject({
        paidAt: { height: H.settle, txIndex: 0 },
        paid: SHARE,
        referral: { ref: { height: H.register, txIndex: 0 }, name: NEWCOMER, referrer: REFERRER, owedTo: REFERRER_OWNER },
      })
      // The reducer still calls it an M that discharged nothing — and this is
      // the reading that stops a report from calling it unexplained money.
      expect(replay.unmatched).toHaveLength(1)
      expect(explainedSettlements(shares).has(refKey({ height: H.settle, txIndex: 0 }))).toBe(true)
    })
  }

  it('an unpriced referral nobody paid is owed by nobody — it never reaches `due`', () => {
    const { shares } = collect([referrerRegistered, referred()], zero)
    expect(shares.outstanding).toEqual([])
    expect(shares.unpriced).toEqual([])
  })

  it('explains a settled and a mispaid payment too, and nothing else', () => {
    const settledRun = collect([referrerRegistered, referred(), paid]).shares
    expect([...explainedSettlements(settledRun)]).toEqual([refKey({ height: H.settle, txIndex: 0 })])
    const short = send(H.settle, 0, TREASURY, encodeSettlement({ height: H.register, txIndex: 0, payee: REFERRER_OWNER, amount: SHARE - 1n }))
    const mispaidRun = collect([referrerRegistered, referred(), short]).shares
    expect([...explainedSettlements(mispaidRun)]).toEqual([refKey({ height: H.settle, txIndex: 0 })])
    const wrongPayee = send(H.settle, 0, TREASURY, encodeSettlement({ height: H.register, txIndex: 0, payee: WINNER, amount: SHARE }))
    expect([...explainedSettlements(collect([referrerRegistered, referred(), wrongPayee]).shares)]).toEqual([])
  })

  it('referralOf reads the log and nothing else — the table decides only the amount', () => {
    const { shares } = collect([referrerRegistered, referred()])
    const leg = shares.created[0]!
    const staged = stageLog([referrerRegistered], config)
    const tx = {
      blockNumber: H.register,
      txIndex: 0,
      hash: 'ab'.repeat(32),
      sender: WINNER,
      recipient: TREASURY,
      value: FEE(NEWCOMER),
      recipientData: encodeRegister({ name: NEWCOMER, fee: FEE(NEWCOMER), ref: REFERRER }).data,
      executionResult: true,
      networkId: config.networkId,
      isReward: false,
    }
    const referral = referralOf(staged.state, tx, { height: H.register, txIndex: 0 }, { kind: 'OK', obligations: [] })
    expect(referral).toMatchObject({ name: NEWCOMER, referrer: REFERRER, owedTo: REFERRER_OWNER, price: FEE(NEWCOMER) })
    expect(referral).not.toHaveProperty('amount')
    expect(leg).toMatchObject({ ...referral, amount: SHARE, rateBp: 1000n })
  })
})

describe('NO_SHARES', () => {
  it('is the empty result, frozen', () => {
    expect(NO_SHARES.created).toEqual([])
    expect(Object.isFrozen(NO_SHARES)).toBe(true)
  })
})
