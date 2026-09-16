import { beforeEach, describe, expect, it } from 'vitest'
import type { Address } from './address.js'
import {
  BURN_ADDRESS,
  type BuiltTransaction,
  encodeAuction,
  encodeBurn,
  encodeBuy,
  encodeCancel,
  encodeDelegate,
  encodeGovernance,
  encodeOffer,
  encodeRegister,
  encodeRenew,
  encodeSetTarget,
  encodeSettlement,
  encodeTransfer,
  encodeUnreserve,
} from './codec.js'
import { CONSTANTS } from './constants.js'
import {
  type ChainTransaction,
  type ReduceResult,
  advanceTo,
  commissionOn,
  feeFor,
  governanceBoundViolation,
  reduce,
  requiredBid,
  termFor,
} from './reduce.js'
import { merkleProof, merkleRoot, verifyProof } from './merkle.js'
import { type NnsState, LAUNCH_PRICES, initialState, lookup, minPrice, resolve } from './state.js'
import { ADMIN, ALICE, BOB, CAROL, MAINNET_ID, MARKETPLACE, PROTOCOL, TREASURY, testConfig } from './test-fixtures.js'

const config = testConfig()
const LAUNCH: number = CONSTANTS.LAUNCH_HEIGHT
/** The 7–11 band's yearly fee at launch prices — every fixture name here is that long. */
const FEE = feeFor('kikename', LAUNCH_PRICES)
/** §3 `MIN_PRICE` at launch prices — the floor on an `O` price (§6 `O`). */
const FLOOR = minPrice(LAUNCH_PRICES)

let state: NnsState
beforeEach(() => {
  state = initialState()
})

interface SendOptions {
  sender: Address
  at?: number
  txIndex?: number
  value?: bigint
  executionResult?: boolean
  isReward?: boolean
  networkId?: number
}

/** Turn a built transaction into the chain transaction the reducer sees. */
const send = (built: BuiltTransaction, options: SendOptions): ChainTransaction => ({
  blockNumber: options.at ?? LAUNCH,
  txIndex: options.txIndex ?? 0,
  hash: `0x${(options.at ?? LAUNCH).toString(16)}${options.txIndex ?? 0}`,
  sender: options.sender,
  recipient: built.recipient,
  value: options.value ?? built.value,
  recipientData: built.data,
  executionResult: options.executionResult ?? true,
  networkId: options.networkId ?? MAINNET_ID,
  ...(options.isReward === undefined ? {} : { isReward: options.isReward }),
})

/** Apply a transaction to the module-level state and return the verdict. */
function step(built: BuiltTransaction, options: SendOptions): ReduceResult {
  const result = reduce(state, send(built, options), config)
  state = result.state
  return result
}

/** Register `kikename` to Alice at LAUNCH, the setup most tests need. */
function registerToAlice(name = 'kikename', at = LAUNCH): void {
  const result = step(encodeRegister({ name, fee: FEE }), { sender: ALICE, at })
  expect(result.verdict.kind).toBe('OK')
}

// ── §7.5 ────────────────────────────────────────────────────────────────────

describe('§7.5 — transactions the indexer must ignore', () => {
  it('failed_G_does_not_register_name', () => {
    // The named conformance case (§14). Albatross includes failed
    // transactions in blocks; without this rule a failed G takes a name.
    const result = step(encodeRegister({ name: 'kikename', fee: FEE }), {
      sender: ALICE,
      executionResult: false,
    })
    expect(result.verdict).toEqual({ kind: 'IGNORED', reason: 'FAILED_EXECUTION' })
    expect(lookup(state, 'kikename')).toBeNull()
    expect(resolve(state, 'kikename')).toBeNull()
  })

  it('ignores reward transactions', () => {
    const result = step(encodeRegister({ name: 'kikename', fee: FEE }), { sender: ALICE, isReward: true })
    expect(result.verdict).toEqual({ kind: 'IGNORED', reason: 'REWARD_TRANSACTION' })
    expect(lookup(state, 'kikename')).toBeNull()
  })

  it('ignores another network, without even advancing height', () => {
    const before = state.height
    const result = step(encodeRegister({ name: 'kikename', fee: FEE }), {
      sender: ALICE,
      at: LAUNCH + 500,
      networkId: MAINNET_ID + 1,
    })
    expect(result.verdict).toEqual({ kind: 'IGNORED', reason: 'WRONG_NETWORK' })
    expect(state.height).toBe(before)
  })

  it('ignores anything before LAUNCH_HEIGHT', () => {
    const result = step(encodeRegister({ name: 'kikename', fee: FEE }), { sender: ALICE, at: LAUNCH - 1 })
    expect(result.verdict).toEqual({ kind: 'IGNORED', reason: 'BEFORE_LAUNCH' })
  })

  it('ignores ordinary chain traffic — the common case', () => {
    const result = reduce(
      state,
      { ...send(encodeRegister({ name: 'kikename', fee: FEE }), { sender: ALICE }), recipientData: '68690a' },
      config,
    )
    expect(result.verdict).toEqual({ kind: 'IGNORED', reason: 'NOT_NNS1' })
  })
})

// ── Canonical ordering ──────────────────────────────────────────────────────

describe('reduce honours the caller-supplied txIndex — §5.2 ranks are computed upstream (rankMessages, r27)', () => {
  const registration = (sender: Address): BuiltTransaction =>
    encodeRegister({ name: 'kikename', fee: FEE })

  it('gives the name to the lower txIndex', () => {
    const first = step(registration(ALICE), { sender: ALICE, at: LAUNCH + 10, txIndex: 0 })
    const second = step(registration(BOB), { sender: BOB, at: LAUNCH + 10, txIndex: 1 })

    expect(first.verdict.kind).toBe('OK')
    expect(second.verdict).toMatchObject({ kind: 'REFUND', reason: 'LOST_REGISTRATION_RACE' })
    expect(lookup(state, 'kikename')?.owner).toBe(ALICE)
  })

  it('reverses when the two transactions swap txIndex — the rank is load-bearing', () => {
    step(registration(BOB), { sender: BOB, at: LAUNCH + 10, txIndex: 0 })
    step(registration(ALICE), { sender: ALICE, at: LAUNCH + 10, txIndex: 1 })
    expect(lookup(state, 'kikename')?.owner).toBe(BOB)
  })

  it('owes the race loser a refund from the treasury', () => {
    step(registration(ALICE), { sender: ALICE, at: LAUNCH + 10, txIndex: 0 })
    const loser = step(registration(BOB), { sender: BOB, at: LAUNCH + 10, txIndex: 1 })

    expect(loser.verdict.kind === 'REFUND' && loser.verdict.obligations).toEqual([
      {
        ref: { height: LAUNCH + 10, txIndex: 1 },
        kind: 'REFUND',
        owedBy: TREASURY,
        owedTo: BOB,
        amount: FEE,
      },
    ])
    expect(state.outstanding.get(`${LAUNCH + 10}:1`)).toHaveLength(1)
  })
})

// ── G ───────────────────────────────────────────────────────────────────────

describe('G — register (§6, §7.4)', () => {
  it('registers with target = sender and expiry = height + TERM_LENGTH', () => {
    registerToAlice('kikename', LAUNCH + 5)
    expect(lookup(state, 'kikename')).toEqual({
      name: 'kikename',
      owner: ALICE,
      target: ALICE,
      expiry: LAUNCH + 5 + CONSTANTS.TERM_LENGTH,
      status: 'REGISTERED',
      host: '',
      evm: '',
    })
    expect(resolve(state, 'kikename')).toBe(ALICE)
  })

  it('prices by length band, measured from the name itself (§10.1)', () => {
    const long = 'a'.repeat(12)
    expect(step(encodeRegister({ name: long, fee: CONSTANTS.FEE_BASE }), { sender: ALICE }).verdict.kind).toBe('OK')
    expect(
      step(encodeRegister({ name: 'kikename', fee: CONSTANTS.FEE_BASE }), { sender: BOB }).verdict,
    ).toMatchObject({ kind: 'REFUND', reason: 'INSUFFICIENT_VALUE' })
  })

  it('prices every open band as a multiple of FEE_BASE — 25×, 10×, 5×, 1× (§10.1)', () => {
    const base = CONSTANTS.FEE_BASE
    for (const [name, times] of [
      ['abcde', 25n],
      ['abcdef', 10n],
      ['abcdefg', 5n],
      ['abcdefghijk', 5n],
      ['abcdefghijkl', 1n],
    ] as const) {
      expect(feeFor(name, LAUNCH_PRICES), name).toBe(base * times)
      expect(step(encodeRegister({ name, fee: base * times - 1n }), { sender: ALICE }).verdict, name).toMatchObject({
        kind: 'REFUND',
        reason: 'INSUFFICIENT_VALUE',
      })
      expect(step(encodeRegister({ name, fee: base * times }), { sender: ALICE }).verdict.kind, name).toBe('OK')
    }
  })

  it('registers a lifetime for ten yearly fees and a hundred terms, as a plain expiry (§10.4)', () => {
    const lifetimeFee = feeFor('kikename', LAUNCH_PRICES, true)
    expect(lifetimeFee).toBe(FEE * CONSTANTS.LIFETIME_MULTIPLIER)
    expect(termFor(true)).toBe(CONSTANTS.LIFETIME_TERMS * CONSTANTS.TERM_LENGTH)

    // Ten yearly fees minus one luna is an underpayment, refunded in full.
    expect(
      step(encodeRegister({ name: 'kikename', fee: lifetimeFee - 1n, lifetime: true }), { sender: ALICE }).verdict,
    ).toEqual({
      kind: 'REFUND',
      reason: 'INSUFFICIENT_VALUE',
      obligations: [{ ref: { height: LAUNCH, txIndex: 0 }, kind: 'REFUND', owedBy: TREASURY, owedTo: ALICE, amount: lifetimeFee - 1n }],
    })

    const result = step(encodeRegister({ name: 'kikename', fee: lifetimeFee, lifetime: true }), { sender: ALICE, at: LAUNCH + 5 })
    expect(result.verdict).toEqual({ kind: 'OK', obligations: [] })
    expect(lookup(state, 'kikename')).toMatchObject({
      owner: ALICE,
      expiry: LAUNCH + 5 + CONSTANTS.LIFETIME_TERMS * CONSTANTS.TERM_LENGTH,
      status: 'REGISTERED',
    })
    // Nothing downstream distinguishes it: it resolves, and it is still a
    // name with an expiry that the ordinary height effect will reach.
    expect(resolve(state, 'kikename')).toBe(ALICE)
    expect(state.nextDueHeight).toBe(LAUNCH + 5 + CONSTANTS.LIFETIME_TERMS * CONSTANTS.TERM_LENGTH)
  })

  it('refunds an underpayment from the treasury, for the full value sent (§7.4, r29)', () => {
    const short = FEE - 1n
    const result = step(encodeRegister({ name: 'kikename', fee: short }), { sender: BOB })
    expect(result.verdict).toEqual({
      kind: 'REFUND',
      reason: 'INSUFFICIENT_VALUE',
      obligations: [
        { ref: { height: LAUNCH, txIndex: 0 }, kind: 'REFUND', owedBy: TREASURY, owedTo: BOB, amount: short },
      ],
    })
    expect(lookup(result.state, 'kikename')).toBeNull()
  })

  it('accepts an overpayment and owes the surplus back from the treasury (§10.5, r29 fold)', () => {
    const result = step(encodeRegister({ name: 'kikename', fee: FEE * 2n }), { sender: ALICE })
    expect(result.verdict).toEqual({
      kind: 'OK',
      obligations: [{ ref: { height: LAUNCH, txIndex: 0 }, kind: 'REFUND', owedBy: TREASURY, owedTo: ALICE, amount: FEE }],
    })
    expect(lookup(result.state, 'kikename')).not.toBeNull()
    expect(result.state.outstanding.get(`${LAUNCH}:0`)).toHaveLength(1)
  })

  it('keeps a surplus under REFUND_FLOOR, as it keeps an underpayment under it', () => {
    const result = step(encodeRegister({ name: 'kikename', fee: FEE + CONSTANTS.REFUND_FLOOR - 1n }), { sender: ALICE })
    expect(result.verdict).toEqual({ kind: 'OK', obligations: [] })
    const exact = step(encodeRegister({ name: 'othername', fee: FEE + CONSTANTS.REFUND_FLOOR }), { sender: ALICE })
    expect(exact.verdict).toMatchObject({ obligations: [{ amount: CONSTANTS.REFUND_FLOOR }] })
  })

  it('an overpaid renewal owes its surplus back too, keyed by the N (§10.5)', () => {
    registerToAlice()
    const result = step(encodeRenew({ name: 'kikename', fee: FEE * 3n }), { sender: BOB, at: LAUNCH + 5 })
    expect(result.verdict).toEqual({
      kind: 'OK',
      obligations: [{ ref: { height: LAUNCH + 5, txIndex: 0 }, kind: 'REFUND', owedBy: TREASURY, owedTo: BOB, amount: FEE * 2n }],
    })
  })

  it('renews for a lifetime with N|L — the upgrade of a yearly name, priced at ten fees (§6 N, §10.4)', () => {
    registerToAlice('kikename', LAUNCH)
    const yearlyExpiry = LAUNCH + CONSTANTS.TERM_LENGTH
    // Ten yearly fees minus one is short, and the whole value comes back.
    expect(step(encodeRenew({ name: 'kikename', fee: FEE * 10n - 1n, lifetime: true }), { sender: BOB, at: LAUNCH + 5 }).verdict).toMatchObject({
      kind: 'REFUND',
      reason: 'INSUFFICIENT_VALUE',
      obligations: [{ amount: FEE * 10n - 1n }],
    })
    // Anyone may pay it, with a surplus owed back like any other renewal.
    const result = step(encodeRenew({ name: 'kikename', fee: FEE * 11n, lifetime: true }), { sender: BOB, at: LAUNCH + 5 })
    expect(result.verdict).toEqual({
      kind: 'OK',
      obligations: [{ ref: { height: LAUNCH + 5, txIndex: 0 }, kind: 'REFUND', owedBy: TREASURY, owedTo: BOB, amount: FEE }],
    })
    // Extends from the current expiry by a hundred terms, not from the height.
    expect(lookup(state, 'kikename')?.expiry).toBe(yearlyExpiry + CONSTANTS.LIFETIME_TERMS * CONSTANTS.TERM_LENGTH)
    // A plain N on a lifetime name adds a year to a date a century out — no rule needed.
    expect(step(encodeRenew({ name: 'kikename', fee: FEE }), { sender: ALICE, at: LAUNCH + 6 }).verdict.kind).toBe('OK')
    expect(lookup(state, 'kikename')?.expiry).toBe(yearlyExpiry + (CONSTANTS.LIFETIME_TERMS + 1) * CONSTANTS.TERM_LENGTH)
  })

  it('forfeits an invalid name, checkable offline', () => {
    // Built by hand: the builder refuses to encode this at all.
    const built = { ...encodeRegister({ name: 'kikename', fee: FEE }), data: hexOf('NNS1Gn1m1q') }
    expect(step(built, { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'INVALID_NAME' })
  })

  it('forfeits a held short name as RESERVED_NAME, not INVALID_NAME — reserved by rule (§4.1)', () => {
    // No list entry exists for `web3`; its membership is its length plus
    // rules 2–5, so the empty test config still reserves it.
    expect(step(encodeRegister({ name: 'web3', fee: FEE }), { sender: ALICE }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'RESERVED_NAME',
    })
  })

  it('forfeits a reserved name, and accepts it once a U has released it', () => {
    // `binance` is on the frozen §4.1 list, so the ordinary config reserves it.
    const reservedConfig = config
    let s = initialState()
    const attempt = (at: number): ReduceResult =>
      reduce(
        s,
        send({ ...encodeRegister({ name: 'kikename', fee: FEE }), data: hexOf('NNS1Gbinance') }, {
          sender: ALICE,
          at,
        }),
        reservedConfig,
      )

    expect(attempt(LAUNCH).verdict).toEqual({ kind: 'FORFEIT', reason: 'RESERVED_NAME' })

    const release = reduce(
      s,
      send(encodeUnreserve({ name: 'binance' }), { sender: ADMIN, at: LAUNCH, txIndex: 1 }),
      reservedConfig,
    )
    expect(release.verdict.kind).toBe('OK')
    s = release.state

    const after = reduce(
      s,
      send({ ...encodeRegister({ name: 'kikename', fee: FEE }), data: hexOf('NNS1Gbinance') }, {
        sender: ALICE,
        at: LAUNCH,
        txIndex: 2,
      }),
      reservedConfig,
    )
    expect(after.verdict.kind).toBe('OK')
  })

  it('forfeits a G against a name in GRACE — the status is provable from the tree', () => {
    registerToAlice()
    const expiry = LAUNCH + CONSTANTS.TERM_LENGTH
    const result = step(encodeRegister({ name: 'kikename', fee: FEE }), { sender: BOB, at: expiry + 1 })
    expect(result.verdict).toEqual({ kind: 'FORFEIT', reason: 'NAME_IN_GRACE' })
  })

  it('forfeits rather than refunds below REFUND_FLOOR (§7.4)', () => {
    // A zero-fee deployment makes the underfunded-race case reachable.
    const free = testConfig()
    let s = initialState()
    const cheap = { ...encodeRegister({ name: 'kikename', fee: FEE }), data: hexOf('NNS1Gkikename') }

    s = reduce(s, { ...send(cheap, { sender: ALICE, at: LAUNCH, txIndex: 0 }), value: FEE }, free).state
    const loser = reduce(
      s,
      { ...send(cheap, { sender: BOB, at: LAUNCH, txIndex: 1 }), value: CONSTANTS.REFUND_FLOOR - 1n },
      free,
    )
    // Underpaid, so it never reaches the race — and since r29 an underpayment
    // is a refund, which the floor turns into a forfeit below one NIM.
    expect(loser.verdict).toEqual({ kind: 'FORFEIT', reason: 'BELOW_REFUND_FLOOR' })
  })

  it('forfeits a G sent anywhere but the treasury', () => {
    const built = { ...encodeRegister({ name: 'kikename', fee: FEE }), recipient: PROTOCOL }
    expect(step(built, { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'WRONG_RECIPIENT' })
  })

  it('records a referrer without letting it affect the outcome (§6 G)', () => {
    expect(
      step(encodeRegister({ name: 'kikename', ref: 'coinbase', fee: FEE }), { sender: ALICE }).verdict.kind,
    ).toBe('OK')
    expect(lookup(state, 'kikename')?.owner).toBe(ALICE)
  })
})

// ── S, D ────────────────────────────────────────────────────────────────────

describe('S — set resolution target (§6)', () => {
  beforeEach(() => registerToAlice())

  it('moves resolution without moving ownership', () => {
    expect(step(encodeSetTarget({ name: 'kikename', target: BOB }), { sender: ALICE }).verdict.kind).toBe('OK')
    expect(resolve(state, 'kikename')).toBe(BOB)
    expect(lookup(state, 'kikename')?.owner).toBe(ALICE)
  })

  it('resets the target to the owner via the PROTOCOL_ADDRESS sentinel (§5.3)', () => {
    step(encodeSetTarget({ name: 'kikename', target: BOB }), { sender: ALICE })
    step(encodeSetTarget({ name: 'kikename', target: null }), { sender: ALICE })
    expect(resolve(state, 'kikename')).toBe(ALICE)
  })

  it('forfeits an S from anyone but the owner', () => {
    expect(step(encodeSetTarget({ name: 'kikename', target: BOB }), { sender: BOB }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'NOT_OWNER',
    })
  })

  it('forfeits an S on a grace-period name', () => {
    const result = step(encodeSetTarget({ name: 'kikename', target: BOB }), {
      sender: ALICE,
      at: LAUNCH + CONSTANTS.TERM_LENGTH,
    })
    expect(result.verdict).toEqual({ kind: 'FORFEIT', reason: 'NAME_NOT_REGISTERED' })
  })
})

describe('D — set delegate resolver (§6)', () => {
  beforeEach(() => registerToAlice('kikename'))

  it('sets and clears the delegate host', () => {
    step(encodeDelegate({ name: 'kikename', host: 'nns.kike.com' }), { sender: ALICE })
    expect(lookup(state, 'kikename')?.host).toBe('nns.kike.com')
    step(encodeDelegate({ name: 'kikename', host: '' }), { sender: ALICE })
    expect(lookup(state, 'kikename')?.host).toBe('')
  })

  it('forfeits a host carrying a scheme', () => {
    const built = { ...encodeDelegate({ name: 'kikename', host: 'x.com' }), data: hexOf('NNS1Dkikename|ht:p') }
    expect(step(built, { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'INVALID_HOST' })
  })
})

// ── X, R, K ─────────────────────────────────────────────────────────────────

describe('X — transfer ownership (§6, §7.3)', () => {
  beforeEach(() => registerToAlice())

  it('waits XFER_TIMELOCK, resolving as before until then', () => {
    step(encodeTransfer({ name: 'kikename', newOwner: BOB }), { sender: ALICE, at: LAUNCH + 1 })
    const effective = LAUNCH + 1 + CONSTANTS.XFER_TIMELOCK

    state = advanceTo(state, effective - 1)
    expect(lookup(state, 'kikename')?.owner).toBe(ALICE)

    state = advanceTo(state, effective)
    expect(lookup(state, 'kikename')?.owner).toBe(BOB)
  })

  it('resets dependent state on taking effect (§7.3)', () => {
    // No offer in the slate since r30: an `X` on a listed name forfeits and an
    // `O` voids a pending one, so a transfer can never mature over an open
    // offer. `applyTransfer` still clears offers — the `B` path and the auction
    // close both reach it — and those are where that reset is exercised.
    step(encodeDelegate({ name: 'kikename', host: 'a.com' }), { sender: ALICE })
    expect(lookup(state, 'kikename')?.host).toBe('a.com')

    step(encodeTransfer({ name: 'kikename', newOwner: BOB }), { sender: ALICE, at: LAUNCH + 100_000 })
    state = advanceTo(state, LAUNCH + 100_000 + CONSTANTS.XFER_TIMELOCK)

    const record = lookup(state, 'kikename')
    expect(record).toMatchObject({ owner: BOB, target: BOB, host: '' })
    expect(state.transfers.has('kikename')).toBe(false)
  })

  it('lets a second X supersede the first and restart the timelock', () => {
    step(encodeTransfer({ name: 'kikename', newOwner: BOB }), { sender: ALICE, at: LAUNCH })
    step(encodeTransfer({ name: 'kikename', newOwner: CAROL }), { sender: ALICE, at: LAUNCH + 100 })

    state = advanceTo(state, LAUNCH + CONSTANTS.XFER_TIMELOCK)
    expect(lookup(state, 'kikename')?.owner).toBe(ALICE)

    state = advanceTo(state, LAUNCH + 100 + CONSTANTS.XFER_TIMELOCK)
    expect(lookup(state, 'kikename')?.owner).toBe(CAROL)
  })

  it('gives every X the same XFER_TIMELOCK — there is no second, longer path (r20)', () => {
    // Through r19 an X from a registered recovery address waited
    // RECOVERY_TIMELOCK instead. Both the mechanism and the constant are gone,
    // so a non-owner has no path at all rather than a slower one.
    const at = LAUNCH + 10
    expect(step(encodeTransfer({ name: 'kikename', newOwner: BOB }), { sender: CAROL, at }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'NOT_OWNER',
    })

    step(encodeTransfer({ name: 'kikename', newOwner: BOB }), { sender: ALICE, at })
    state = advanceTo(state, at + CONSTANTS.XFER_TIMELOCK)
    expect(lookup(state, 'kikename')?.owner).toBe(BOB)
  })

  it('forfeits an X from a stranger', () => {
    expect(step(encodeTransfer({ name: 'kikename', newOwner: BOB }), { sender: BOB }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'NOT_OWNER',
    })
  })

  describe('an open offer is exclusive with a transfer (§6 X, r30)', () => {
    const list = (at: number) => step(encodeOffer({ name: 'kikename', price: FLOOR, minPrice: FLOOR }), { sender: ALICE, at })

    it('forfeits OFFER_OPEN, leaving the listing exactly as it was', () => {
      list(LAUNCH + 1)
      const before = state.offers.get('kikename')
      expect(step(encodeTransfer({ name: 'kikename', newOwner: BOB }), { sender: ALICE, at: LAUNCH + 2 }).verdict).toEqual({
        kind: 'FORFEIT',
        reason: 'OFFER_OPEN',
      })
      expect(state.transfers.has('kikename')).toBe(false)
      expect(state.offers.get('kikename')).toEqual(before)
    })

    it('lets the transfer through once a K has taken the name off sale', () => {
      list(LAUNCH + 1)
      const at = LAUNCH + 1 + CONSTANTS.OFFER_IRREVOCABLE
      expect(step(encodeCancel({ name: 'kikename' }), { sender: ALICE, at }).verdict.kind).toBe('OK')
      expect(step(encodeTransfer({ name: 'kikename', newOwner: BOB }), { sender: ALICE, at: at + 1 }).verdict.kind).toBe('OK')
      state = advanceTo(state, at + 1 + CONSTANTS.XFER_TIMELOCK)
      expect(lookup(state, 'kikename')?.owner).toBe(BOB)
    })

    it('tells a stranger they are a stranger first — NOT_OWNER beats OFFER_OPEN', () => {
      list(LAUNCH + 1)
      expect(step(encodeTransfer({ name: 'kikename', newOwner: CAROL }), { sender: BOB, at: LAUNCH + 2 }).verdict).toEqual({
        kind: 'FORFEIT',
        reason: 'NOT_OWNER',
      })
    })

    it('an expired offer is no offer: the X lands once OFFER_MAX_LIFETIME is past', () => {
      // The offer goes on its own, with no `K` and no log line (§7.6), so the
      // gate must read the live set rather than "was this name ever listed".
      list(LAUNCH + 1)
      const gone = LAUNCH + 1 + CONSTANTS.OFFER_MAX_LIFETIME
      state = advanceTo(state, gone)
      expect(step(encodeTransfer({ name: 'kikename', newOwner: BOB }), { sender: ALICE, at: gone }).verdict.kind).toBe('OK')
    })

    it('converse: an O voids a pending X, and that X never matures', () => {
      step(encodeTransfer({ name: 'kikename', newOwner: CAROL }), { sender: ALICE, at: LAUNCH + 1 })
      const wouldMature = LAUNCH + 1 + CONSTANTS.XFER_TIMELOCK
      expect(list(LAUNCH + 2).verdict.kind).toBe('OK')
      expect(state.transfers.has('kikename')).toBe(false)

      state = advanceTo(state, wouldMature + 1)
      expect(lookup(state, 'kikename')?.owner).toBe(ALICE)
    })

    it('converse: the voided X does not leave nextDueHeight pointing at a ghost', () => {
      step(encodeTransfer({ name: 'kikename', newOwner: CAROL }), { sender: ALICE, at: LAUNCH + 1 })
      expect(state.nextDueHeight).toBe(LAUNCH + 1 + CONSTANTS.XFER_TIMELOCK)
      list(LAUNCH + 2)
      // Re-derived on the void, not left at the transfer's maturity: the next
      // thing actually due is the offer's own expiry.
      expect(state.nextDueHeight).toBe(LAUNCH + 2 + CONSTANTS.OFFER_MAX_LIFETIME)
    })

    it('no order of O and X leaves the two standing together', () => {
      // The whole point of the rule, asserted as a property rather than as two
      // separate outcomes: whichever way round the owner sends them, the name
      // ends with at most one of the pair.
      const bothStanding = () => state.offers.has('kikename') && state.transfers.has('kikename')

      list(LAUNCH + 1)
      step(encodeTransfer({ name: 'kikename', newOwner: BOB }), { sender: ALICE, at: LAUNCH + 2 })
      expect(bothStanding()).toBe(false)

      state = initialState()
      registerToAlice()
      step(encodeTransfer({ name: 'kikename', newOwner: BOB }), { sender: ALICE, at: LAUNCH + 1 })
      list(LAUNCH + 2)
      expect(bothStanding()).toBe(false)
    })
  })
})

describe('K — cancel (§6)', () => {
  beforeEach(() => registerToAlice())

  it('vetoes a pending transfer, effective on inclusion', () => {
    step(encodeTransfer({ name: 'kikename', newOwner: BOB }), { sender: ALICE })
    expect(step(encodeCancel({ name: 'kikename' }), { sender: ALICE, at: LAUNCH + 1 }).verdict.kind).toBe('OK')

    state = advanceTo(state, LAUNCH + CONSTANTS.XFER_TIMELOCK + 1)
    expect(lookup(state, 'kikename')?.owner).toBe(ALICE)
  })

  it('is owner-only: nobody else can veto (r20)', () => {
    // Through r19 a registered recovery address could K too. That is the
    // mechanism r20 removed — the owner key could delete a recovery-initiated
    // X with a bare K at DUST_VALUE, indefinitely, so the veto was never
    // usable *against* the key it was meant to defend against.
    step(encodeTransfer({ name: 'kikename', newOwner: BOB }), { sender: ALICE })
    expect(step(encodeCancel({ name: 'kikename' }), { sender: CAROL, at: LAUNCH + 1 }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'NOT_OWNER',
    })

    state = advanceTo(state, LAUNCH + CONSTANTS.XFER_TIMELOCK)
    expect(lookup(state, 'kikename')?.owner).toBe(BOB)
  })

  it('cannot withdraw an offer inside OFFER_IRREVOCABLE, and can after', () => {
    step(encodeOffer({ name: 'kikename', price: FLOOR, minPrice: FLOOR }), { sender: ALICE, at: LAUNCH })
    expect(step(encodeCancel({ name: 'kikename' }), { sender: ALICE, at: LAUNCH + 1 }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'NOTHING_TO_CANCEL',
    })

    const at = LAUNCH + CONSTANTS.OFFER_IRREVOCABLE
    expect(step(encodeCancel({ name: 'kikename' }), { sender: ALICE, at }).verdict.kind).toBe('OK')
    expect(state.offers.has('kikename')).toBe(false)
  })
})

// ── Expiry ──────────────────────────────────────────────────────────────────

describe('§7.3 expiry — the height-driven path', () => {
  beforeEach(() => registerToAlice())
  const expiry = LAUNCH + CONSTANTS.TERM_LENGTH

  it('stops resolving on entering GRACE, but keeps the name in the tree', () => {
    state = advanceTo(state, expiry)
    expect(lookup(state, 'kikename')?.status).toBe('GRACE')
    expect(resolve(state, 'kikename')).toBeNull()
  })

  it('clears the delegate host on entering GRACE — a lapsed name cannot answer for subdomains', () => {
    step(encodeDelegate({ name: 'kikename', host: 'a.com' }), { sender: ALICE })
    state = advanceTo(state, expiry)
    expect(lookup(state, 'kikename')?.host).toBe('')
  })

  it('falls to AVAILABLE after GRACE_PERIOD, clearing all state', () => {
    state = advanceTo(state, expiry + CONSTANTS.GRACE_PERIOD)
    expect(lookup(state, 'kikename')).toBeNull()
  })

  it('crosses both boundaries in a single advance', () => {
    // The reason advanceTo runs to a fixed point rather than one pass.
    state = advanceTo(state, expiry + CONSTANTS.GRACE_PERIOD + 1)
    expect(lookup(state, 'kikename')).toBeNull()
  })

  it('is renewable during GRACE by anyone, from the current expiry', () => {
    state = advanceTo(state, expiry + 10)
    expect(step(encodeRenew({ name: 'kikename', fee: FEE }), { sender: BOB, at: expiry + 10 }).verdict.kind).toBe(
      'OK',
    )
    const record = lookup(state, 'kikename')
    expect(record?.status).toBe('REGISTERED')
    expect(record?.expiry).toBe(expiry + CONSTANTS.TERM_LENGTH)
    expect(record?.owner).toBe(ALICE)
  })

  it('never penalises an early renewal', () => {
    step(encodeRenew({ name: 'kikename', fee: FEE }), { sender: ALICE, at: LAUNCH + 1 })
    expect(lookup(state, 'kikename')?.expiry).toBe(expiry + CONSTANTS.TERM_LENGTH)
  })

  it('refuses to advance backwards', () => {
    state = advanceTo(state, LAUNCH + 100)
    expect(() => advanceTo(state, LAUNCH + 99)).toThrow(/cannot advance/)
  })
})

describe('ordering of effects that come due at the same height', () => {
  it('runs a maturing transfer before the expiry it collides with', () => {
    // The two readings do not agree: expire first would cancel the pending X
    // as part of the grace reset and leave the name with Alice. Ratified into
    // §7.3 by r15.
    registerToAlice()
    const expiry = LAUNCH + CONSTANTS.TERM_LENGTH
    step(encodeTransfer({ name: 'kikename', newOwner: BOB }), {
      sender: ALICE,
      at: expiry - CONSTANTS.XFER_TIMELOCK,
    })

    state = advanceTo(state, expiry)
    expect(lookup(state, 'kikename')).toMatchObject({ owner: BOB, status: 'GRACE' })
  })

  it('fires every §7.3 category due at one height, in §7.3 order, before that block’s transactions', () => {
    // One height with all six categories due at once. §7.3 fixes the order —
    // governance, maturing X, expiry, grace release, auction close (r28,
    // moved behind the expiry 2026-09-03), offer expiry — and fixes
    // that the whole batch runs *before* the block's own transactions, which
    // is what the final `G` here checks. r22 removed the unreserve step: a `U`
    // executes in its landing block and schedules nothing.
    const reserving = config
    const at = (height: number): SendOptions => ({ sender: ALICE, at: height })
    /** `step`, but against the reserving config this one test needs. */
    const send1 = (built: BuiltTransaction, options: SendOptions): ReduceResult => {
      const result = reduce(state, send(built, options), reserving)
      state = result.state
      return result
    }
    // No builder will encode a reserved name, so the final `G` is hand-made.
    const registerBinance = (fee: bigint): BuiltTransaction => ({
      ...encodeRegister({ name: 'gracename', fee }),
      data: hexOf('NNS1Gbinance'),
    })
    state = initialState()

    const H = LAUNCH + CONSTANTS.TERM_LENGTH + CONSTANTS.GRACE_PERIOD

    // Replay is forward-only, so the setup is written in height order.
    // Releases to AVAILABLE at H: registered at LAUNCH, so expiry + GRACE = H.
    send1(encodeRegister({ name: 'gracename', fee: FEE }), at(LAUNCH))
    // Both expire at H; `expirename` also carries a transfer maturing there.
    send1(encodeRegister({ name: 'expirename', fee: FEE }), at(H - CONSTANTS.TERM_LENGTH))
    send1(encodeRegister({ name: 'offername', fee: FEE }), at(H - CONSTANTS.TERM_LENGTH))
    // An auction closing at H on a name that outlives it (registered 100 blocks later).
    send1(encodeRegister({ name: 'closename', fee: FEE }), at(H - CONSTANTS.TERM_LENGTH + 100))
    // An offer expiring at H.
    send1(encodeOffer({ name: 'offername', price: FLOOR, minPrice: FLOOR }), {
      sender: ALICE,
      at: H - CONSTANTS.OFFER_MAX_LIFETIME,
    })
    // The `U` releasing `binance` is not scheduled at all since r22 — it fires
    // in its own block, well before H, and its only trace here is that the
    // final `G` for the name is registrable.
    send1(encodeAuction({ name: 'closename', startingPrice: FLOOR, endHeight: H, minPrice: FLOOR }), at(H - CONSTANTS.AUCTION_MIN_DURATION - 5))
    send1(encodeBuy({ name: 'closename', price: FLOOR }), { sender: BOB, at: H - CONSTANTS.AUCTION_MIN_DURATION - 4 })
    const notice = H - CONSTANTS.GOVERNANCE_DELAY
    send1(encodeUnreserve({ name: 'binance' }), { sender: ADMIN, at: notice })
    send1(
      encodeGovernance({
        feeBase: CONSTANTS.FEE_BASE * 2n,
        commissionBp: CONSTANTS.COMMISSION_RATE,
        effectiveHeight: H,
      }),
      { sender: ADMIN, at: notice },
    )
    send1(encodeTransfer({ name: 'expirename', newOwner: BOB }), at(H - CONSTANTS.XFER_TIMELOCK))

    state = advanceTo(state, H)

    expect(state.prices.feeBase).toBe(CONSTANTS.FEE_BASE * 2n) // governance activated
    expect(state.unreserved.has('binance')).toBe(true) // released back at `notice`
    expect(lookup(state, 'expirename')).toMatchObject({ owner: BOB, status: 'GRACE' }) // X before expiry
    expect(state.auctions.has('closename')).toBe(false) // auction closed…
    expect(lookup(state, 'closename')).toMatchObject({ owner: BOB, status: 'REGISTERED' }) // …to the bidder, still in term
    // …at the commission rate that activated in this very block (§6 A: governance first)
    expect(state.outstanding.get(`${H - CONSTANTS.AUCTION_MIN_DURATION - 4}:0`)?.find((leg) => leg.kind === 'COMMISSION')?.amount).toBe(
      commissionOn(FLOOR, CONSTANTS.COMMISSION_RATE),
    )
    expect(lookup(state, 'gracename')).toBeNull() // grace released
    expect(state.offers.has('offername')).toBe(false) // offer expired

    // …and all of it before H's own transactions: this `G` is only sufficient
    // at the raised fee, which is the height-driven governance step landing
    // ahead of the block body.
    expect(send1(registerBinance(FEE), at(H)).verdict).toMatchObject({ kind: 'REFUND', reason: 'INSUFFICIENT_VALUE' })
    expect(send1(registerBinance(FEE * 2n), at(H)).verdict.kind).toBe('OK')
  })
})

describe('nextDueHeight is only ever a lower bound', () => {
  it('recomputes rather than skipping when a superseded X leaves it stale', () => {
    registerToAlice()
    step(encodeTransfer({ name: 'kikename', newOwner: BOB }), { sender: ALICE, at: LAUNCH })
    // Supersede with a later X. The bound still points at the first one's
    // maturity, which is now earlier than anything that will actually fire.
    step(encodeTransfer({ name: 'kikename', newOwner: CAROL }), { sender: ALICE, at: LAUNCH + 1_000 })

    const stale = LAUNCH + CONSTANTS.XFER_TIMELOCK
    expect(state.nextDueHeight).toBe(stale)

    state = advanceTo(state, stale)
    expect(lookup(state, 'kikename')?.owner).toBe(ALICE)
    // The scan found nothing and tightened the bound to the real one.
    expect(state.nextDueHeight).toBe(LAUNCH + 1_000 + CONSTANTS.XFER_TIMELOCK)

    state = advanceTo(state, LAUNCH + 1_000 + CONSTANTS.XFER_TIMELOCK)
    expect(lookup(state, 'kikename')?.owner).toBe(CAROL)
  })

  it('advances height without a scan when nothing is due', () => {
    registerToAlice()
    const before = state.nextDueHeight
    state = advanceTo(state, LAUNCH + 42)
    expect(state.height).toBe(LAUNCH + 42)
    expect(state.nextDueHeight).toBe(before)
  })
})

// ── Marketplace ─────────────────────────────────────────────────────────────

describe('O, B and M — the marketplace (§6)', () => {
  const PRICE = 100_000_000n
  beforeEach(() => {
    registerToAlice()
    step(encodeOffer({ name: 'kikename', price: PRICE, minPrice: FLOOR }), { sender: ALICE })
  })

  it('moves ownership immediately on a winning B, settlement never gating it', () => {
    const result = step(encodeBuy({ name: 'kikename', price: PRICE }), { sender: BOB, at: LAUNCH + 1 })
    expect(result.verdict.kind).toBe('OK')
    expect(lookup(state, 'kikename')).toMatchObject({ owner: BOB, target: BOB, host: '' })
    expect(state.offers.has('kikename')).toBe(false)
  })

  it('lets the buyer inherit the name’s current expiry', () => {
    step(encodeBuy({ name: 'kikename', price: PRICE }), { sender: BOB, at: LAUNCH + 1 })
    expect(lookup(state, 'kikename')?.expiry).toBe(LAUNCH + CONSTANTS.TERM_LENGTH)
  })

  it('splits the price into seller proceeds and commission that sum exactly (§6 M)', () => {
    const result = step(encodeBuy({ name: 'kikename', price: PRICE }), { sender: BOB, at: LAUNCH + 1 })
    const obligations = result.verdict.kind === 'OK' ? result.verdict.obligations : []
    const commission = commissionOn(PRICE, CONSTANTS.COMMISSION_RATE)

    expect(obligations).toEqual([
      {
        ref: { height: LAUNCH + 1, txIndex: 0 },
        kind: 'SALE_PROCEEDS',
        owedBy: MARKETPLACE,
        owedTo: ALICE,
        amount: PRICE - commission,
      },
      {
        ref: { height: LAUNCH + 1, txIndex: 0 },
        kind: 'COMMISSION',
        owedBy: MARKETPLACE,
        owedTo: TREASURY,
        amount: commission,
      },
    ])
    expect(obligations.reduce((sum, o) => sum + o.amount, 0n)).toBe(PRICE)
  })

  it('floors the commission, with the seller taking the remainder', () => {
    // 999 * 250 / 10000 = 24.975 → 24, seller 975.
    expect(commissionOn(999n, 250n)).toBe(24n)
    expect(999n - commissionOn(999n, 250n)).toBe(975n)
  })

  it('refunds the race loser and leaves ownership with the winner', () => {
    step(encodeBuy({ name: 'kikename', price: PRICE }), { sender: BOB, at: LAUNCH + 1, txIndex: 0 })
    const loser = step(encodeBuy({ name: 'kikename', price: PRICE }), {
      sender: CAROL,
      at: LAUNCH + 1,
      txIndex: 1,
    })
    expect(loser.verdict).toMatchObject({ kind: 'REFUND', reason: 'OFFER_NOT_OPEN' })
    expect(lookup(state, 'kikename')?.owner).toBe(BOB)
  })

  it('refunds a B whose value is not exactly the price', () => {
    const built = encodeBuy({ name: 'kikename', price: PRICE })
    expect(step(built, { sender: BOB, at: LAUNCH + 1, value: PRICE - 1n }).verdict).toMatchObject({
      kind: 'REFUND',
      reason: 'WRONG_PRICE',
    })
    expect(lookup(state, 'kikename')?.owner).toBe(ALICE)
  })

  it('never deducts a commission from a refund', () => {
    const built = encodeBuy({ name: 'kikename', price: PRICE })
    const result = step(built, { sender: BOB, at: LAUNCH + 1, value: PRICE + 1n })
    const obligations = result.verdict.kind === 'REFUND' ? result.verdict.obligations : []
    expect(obligations[0]?.amount).toBe(PRICE + 1n)
  })

  it('expires an offer at OFFER_MAX_LIFETIME', () => {
    state = advanceTo(state, LAUNCH + CONSTANTS.OFFER_MAX_LIFETIME)
    expect(state.offers.has('kikename')).toBe(false)
    expect(step(encodeBuy({ name: 'kikename', price: PRICE }), {
      sender: BOB,
      at: LAUNCH + CONSTANTS.OFFER_MAX_LIFETIME,
    }).verdict).toMatchObject({ kind: 'REFUND', reason: 'OFFER_NOT_OPEN' })
  })

  it('discharges one leg per M, leaving the other outstanding', () => {
    step(encodeBuy({ name: 'kikename', price: PRICE }), { sender: BOB, at: LAUNCH + 1 })
    const key = `${LAUNCH + 1}:0`
    expect(state.outstanding.get(key)).toHaveLength(2)

    const commission = commissionOn(PRICE, CONSTANTS.COMMISSION_RATE)
    step(
      encodeSettlement({
        height: LAUNCH + 1,
        txIndex: 0,
        payee: ALICE,
        amount: PRICE - commission,
      }),
      { sender: MARKETPLACE, at: LAUNCH + 2 },
    )
    expect(state.outstanding.get(key)).toHaveLength(1)

    step(encodeSettlement({ height: LAUNCH + 1, txIndex: 0, payee: TREASURY, amount: commission }), {
      sender: MARKETPLACE,
      at: LAUNCH + 3,
    })
    expect(state.outstanding.has(key)).toBe(false)
  })

  it('leaves the debt standing when an M underpays — the log makes the shortfall visible', () => {
    step(encodeBuy({ name: 'kikename', price: PRICE }), { sender: BOB, at: LAUNCH + 1 })
    step(encodeSettlement({ height: LAUNCH + 1, txIndex: 0, payee: ALICE, amount: 1n }), {
      sender: MARKETPLACE,
      at: LAUNCH + 2,
    })
    expect(state.outstanding.get(`${LAUNCH + 1}:0`)).toHaveLength(2)
  })

  it('forfeits an M from anyone but the marketplace or the treasury', () => {
    expect(
      step(encodeSettlement({ height: LAUNCH, txIndex: 0, payee: ALICE, amount: 1n }), {
        sender: BOB,
        at: LAUNCH + 2,
      }).verdict,
    ).toEqual({ kind: 'FORFEIT', reason: 'WRONG_SENDER' })
  })
})

// ── MIN_PRICE ───────────────────────────────────────────────────────────────

describe('MIN_PRICE — the floor on an O price (§3, §6 O)', () => {
  /** No builder will encode below the floor, so these are assembled by hand. */
  const offerAt = (price: bigint): BuiltTransaction => ({
    ...encodeOffer({ name: 'kikename', price: FLOOR, minPrice: FLOOR }),
    data: hexOf(`NNS1Okikename|${price}`),
  })

  beforeEach(() => registerToAlice())

  it('accepts a price exactly at the floor — the boundary is inclusive', () => {
    expect(step(offerAt(FLOOR), { sender: ALICE }).verdict.kind).toBe('OK')
    expect(state.offers.get('kikename')?.price).toBe(FLOOR)
  })

  it('forfeits one luna below the floor', () => {
    expect(step(offerAt(FLOOR - 1n), { sender: ALICE }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'BELOW_MIN_PRICE',
    })
    expect(state.offers.has('kikename')).toBe(false)
  })

  it.each([
    // The three readings §6 `O` records for rejecting a token floor. Each is a
    // price a floor of "1 luna" would have admitted, and each breaks a rule
    // somewhere else in the protocol.
    ['0, which no B can satisfy — the network rejects value: 0 (§5.4)', 0n],
    ['1 luna, the token floor considered and rejected', 1n],
    ['below REFUND_FLOOR, where a losing bidder is forfeited, not refunded (§7.4)', CONSTANTS.REFUND_FLOOR - 1n],
    ['small enough that floor(price × AUCTION_MIN_INCREMENT) is 0, erasing the increment rule', 19n],
  ])('forfeits a price %s', (_label, price) => {
    expect(step(offerAt(price), { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'BELOW_MIN_PRICE' })
  })

  it('pins why 19 luna erases the auction increment rule', () => {
    // floor(19 × 5%) = 0: a bid could match the standing one and still "raise".
    expect(commissionOn(19n, CONSTANTS.AUCTION_MIN_INCREMENT_BP)).toBe(0n)
    expect(commissionOn(20n, CONSTANTS.AUCTION_MIN_INCREMENT_BP)).toBe(1n)
  })

  it('moves the floor with FEE_BASE, reading it from state and not from constants', () => {
    // A P that doubles FEE_BASE doubles MIN_PRICE with it. An implementation
    // reading CONSTANTS.FEE_BASE is right until this block and wrong after.
    const effective = LAUNCH + CONSTANTS.GOVERNANCE_DELAY
    step(
      encodeGovernance({
        feeBase: FLOOR * 2n,
        commissionBp: CONSTANTS.COMMISSION_RATE,
        effectiveHeight: effective,
      }),
      { sender: ADMIN },
    )

    expect(step(offerAt(FLOOR), { sender: ALICE, at: effective - 1 }).verdict.kind).toBe('OK')
    expect(step(offerAt(FLOOR), { sender: ALICE, at: effective }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'BELOW_MIN_PRICE',
    })
    expect(step(offerAt(FLOOR * 2n), { sender: ALICE, at: effective }).verdict.kind).toBe('OK')
  })

  it('claims a below-floor O on its own defect, whatever it paid', () => {
    // The floor is checked before the value carried, the same way `G` checks
    // name syntax first: a message whose payload is unusable is rejected on
    // that ground. LISTING_FEE is frozen at zero, so INSUFFICIENT_VALUE is
    // unreachable for `O` — but the *order* is what this pins, and it is what
    // a spec revision moving the fee would rely on.
    expect(CONSTANTS.LISTING_FEE).toBe(0n)
    const built = { ...offerAt(1n), recipient: TREASURY, value: 1n }
    const result = reduce(state, send(built, { sender: ALICE }), config)
    expect(result.verdict).toEqual({ kind: 'FORFEIT', reason: 'BELOW_MIN_PRICE' })
  })
})

// ── Governance ──────────────────────────────────────────────────────────────

describe('P — governance (§6, §10.6)', () => {
  const effective = LAUNCH + CONSTANTS.GOVERNANCE_DELAY
  const proposal = (over: Partial<{ feeBase: bigint; commissionBp: bigint }> = {}) =>
    encodeGovernance({
      feeBase: CONSTANTS.FEE_BASE,
      commissionBp: CONSTANTS.COMMISSION_RATE,
      effectiveHeight: effective,
      ...over,
    })

  it('takes effect only at effective_height, so nothing in flight is invalidated', () => {
    step(proposal({ feeBase: CONSTANTS.FEE_BASE * 2n }), { sender: ADMIN })
    expect(state.prices.feeBase).toBe(CONSTANTS.FEE_BASE)

    state = advanceTo(state, effective)
    expect(state.prices.feeBase).toBe(CONSTANTS.FEE_BASE * 2n)
  })

  it('moves every band with the one base fee (§10.1)', () => {
    step(proposal({ feeBase: CONSTANTS.FEE_BASE * 3n }), { sender: ADMIN })
    state = advanceTo(state, effective)
    for (const name of ['abcde', 'abcdef', 'kikename', 'abcdefghijkl']) {
      expect(feeFor(name, state.prices), name).toBe(feeFor(name, LAUNCH_PRICES) * 3n)
    }
    expect(minPrice(state.prices)).toBe(FLOOR * 3n)
  })

  it('validates a registration against the price at its own block height', () => {
    step(proposal({ feeBase: CONSTANTS.FEE_BASE * 2n }), { sender: ADMIN })
    expect(step(encodeRegister({ name: 'kikename', fee: FEE }), { sender: ALICE, at: effective - 1 }).verdict.kind).toBe(
      'OK',
    )
    expect(step(encodeRegister({ name: 'othername', fee: FEE }), { sender: ALICE, at: effective }).verdict).toMatchObject(
      { kind: 'REFUND', reason: 'INSUFFICIENT_VALUE' },
    )
  })

  it('forfeits a P from anyone but ADMIN_ADDRESS', () => {
    expect(step(proposal(), { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'NOT_ADMIN' })
  })

  it('forfeits without GOVERNANCE_DELAY notice', () => {
    const built = encodeGovernance({
      feeBase: CONSTANTS.FEE_BASE,
      commissionBp: CONSTANTS.COMMISSION_RATE,
      effectiveHeight: LAUNCH + CONSTANTS.GOVERNANCE_DELAY - 1,
    })
    expect(step(built, { sender: ADMIN }).verdict).toEqual({ kind: 'FORFEIT', reason: 'INSUFFICIENT_NOTICE' })
  })

  it.each([
    ['below PRICE_FLOOR', { feeBase: 0n }],
    ['above PRICE_CEILING', { feeBase: CONSTANTS.PRICE_CEILING + 1n }],
    ['commission above the ceiling', { commissionBp: CONSTANTS.COMMISSION_CEILING + 1n }],
    ['commission step above the maximum', { commissionBp: CONSTANTS.COMMISSION_RATE + CONSTANTS.COMMISSION_MAX_STEP + 1n }],
  ])('forfeits a P %s', (_label, over) => {
    expect(step(proposal(over), { sender: ADMIN }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'GOVERNANCE_BOUND_VIOLATED',
    })
  })

  it('accepts a second P in the very next block — there is no frequency bound', () => {
    // PRICE_MIN_INTERVAL is gone (§10.6): a rate limit loose enough to permit
    // legitimate repricing is loose enough for an attacker to walk through, so
    // nothing here counts blocks between accepted messages. The pending change
    // from the first P is simply replaced by the second.
    step(proposal({ feeBase: CONSTANTS.FEE_BASE * 2n }), { sender: ADMIN })
    const next = encodeGovernance({
      feeBase: CONSTANTS.FEE_BASE * 3n,
      commissionBp: CONSTANTS.COMMISSION_RATE,
      effectiveHeight: LAUNCH + 1 + CONSTANTS.GOVERNANCE_DELAY,
    })
    expect(step(next, { sender: ADMIN, at: LAUNCH + 1 }).verdict.kind).toBe('OK')
    expect(state.pendingGovernance?.prices.feeBase).toBe(CONSTANTS.FEE_BASE * 3n)
  })

  it('lets one P reach the floor, which the rails do not prevent (§10.6)', () => {
    // The rails are fat-finger protection, not attack protection: PRICE_FLOOR
    // itself is a legal target in a single message, and the only thing between
    // a stolen key and that price is GOVERNANCE_DELAY's public notice.
    expect(
      step(proposal({ feeBase: CONSTANTS.PRICE_FLOOR }), { sender: ADMIN }).verdict.kind,
    ).toBe('OK')
  })

  // The reducer collapses every bound into one verdict token. A client
  // building a `P` cannot: a violation is forfeited on-chain and cannot be
  // retracted, so it has to be able to say which bound it broke before
  // signing. Same function, so the two can never disagree about *whether*.
  describe('governanceBoundViolation', () => {
    const launch = LAUNCH_PRICES

    it('answers null when every bound holds', () => {
      expect(governanceBoundViolation(launch, launch)).toBeNull()
      expect(
        governanceBoundViolation(launch, {
          feeBase: CONSTANTS.FEE_BASE * 2n,
          commissionBp: CONSTANTS.COMMISSION_RATE + CONSTANTS.COMMISSION_MAX_STEP,
        }),
      ).toBeNull()
    })

    it.each([
      ['PRICE_BAND', { feeBase: 0n }],
      ['COMMISSION_CEILING', { commissionBp: CONSTANTS.COMMISSION_CEILING + 1n }],
      ['COMMISSION_MAX_STEP', { commissionBp: CONSTANTS.COMMISSION_RATE + CONSTANTS.COMMISSION_MAX_STEP + 1n }],
    ])('names %s, and the reducer forfeits the same message', (bound, over) => {
      const proposed = { ...launch, ...over }
      expect(governanceBoundViolation(launch, proposed)?.bound).toBe(bound)
      expect(step(proposal(over), { sender: ADMIN }).verdict).toEqual({
        kind: 'FORFEIT',
        reason: 'GOVERNANCE_BOUND_VIOLATED',
      })
    })

    it('accepts any price inside the rails, however far it moves in one step', () => {
      // What is left is a range check, not a rate limit: floor to ceiling in a
      // single message is a legal P, and the CLI's job is to warn a human
      // rather than to refuse it (packages/admin).
      expect(
        governanceBoundViolation(launch, { feeBase: CONSTANTS.PRICE_CEILING, commissionBp: CONSTANTS.COMMISSION_RATE }),
      ).toBeNull()
      expect(
        governanceBoundViolation(launch, { feeBase: CONSTANTS.PRICE_FLOOR, commissionBp: CONSTANTS.COMMISSION_RATE }),
      ).toBeNull()
    })
  })
})

describe('U — unreserve (§6)', () => {
  // `binance` is on the frozen §4.1 published list (§3), not a fixture entry.
  const reserving = config

  /** `step`, but against the config that reserves `binance`. */
  const stepR = (built: BuiltTransaction, options: SendOptions): ReduceResult => {
    const result = reduce(state, send(built, options), reserving)
    state = result.state
    return result
  }

  const unreserve = (recipient: Address | null = null): BuiltTransaction =>
    encodeUnreserve({ name: 'binance', recipient })

  beforeEach(() => {
    state = initialState()
  })

  it('forfeits from anyone but ADMIN_ADDRESS', () => {
    expect(stepR(unreserve(), { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'NOT_ADMIN' })
  })

  it('forfeits an award to BURN_ADDRESS, in its own row of the §7.4 order', () => {
    // The builder refuses to produce this, so the recipient is swapped by hand.
    const toBurn: BuiltTransaction = { ...unreserve(), recipient: BURN_ADDRESS }
    // NOT_ADMIN still comes first…
    expect(stepR(toBurn, { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'NOT_ADMIN' })
    // …then INVALID_RECIPIENT, *before* the name rows: the recipient decides
    // which of two operations the message even is (§7.4). r22 removed the
    // notice row this used to precede; the reason it leads is unchanged.
    const badName: BuiltTransaction = { ...toBurn, data: hexOf('NNS1Uab-') }
    expect(stepR(badName, { sender: ADMIN }).verdict).toEqual({ kind: 'FORFEIT', reason: 'INVALID_RECIPIENT' })
  })

  it('forfeits a name failing §4.1 rules 2–5 or the ceiling — but the floor never binds a U', () => {
    // `ab-` fails rule 4 and is on neither §4.1 membership route, so no U may
    // release or award it. Built by hand: the builder refuses it too.
    const built: BuiltTransaction = { ...unreserve(), data: hexOf('NNS1Uab-') }
    expect(stepR(built, { sender: ADMIN }).verdict).toEqual({ kind: 'FORFEIT', reason: 'INVALID_NAME' })
  })

  it('releases a short name — reserved by rule, no list entry — and a later G registers it (r18)', () => {
    // r22: the release lands and fires in the same block. A `G` in an earlier
    // block still sees a reserved name.
    expect(stepR(encodeRegister({ name: 'web3', fee: FEE }), { sender: ALICE, at: LAUNCH }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'RESERVED_NAME',
    })

    expect(stepR(encodeUnreserve({ name: 'web3' }), { sender: ADMIN, at: LAUNCH + 1 }).verdict).toEqual({
      kind: 'OK',
      obligations: [],
    })
    expect(state.unreserved.has('web3')).toBe(true)

    // Released, the floor no longer binds (§4.1): a normal registration, at
    // the 4-character band — 50× the base, the holding cost of a released
    // short name (§10.1). The 7–11 fee is an underpayment for it.
    expect(stepR(encodeRegister({ name: 'web3', fee: FEE }), { sender: ALICE, at: LAUNCH + 2 }).verdict).toMatchObject({
      kind: 'REFUND',
      reason: 'INSUFFICIENT_VALUE',
    })
    const band = feeFor('web3', LAUNCH_PRICES)
    expect(band).toBe(CONSTANTS.FEE_BASE * 50n)
    const result = stepR(encodeRegister({ name: 'web3', fee: band }), { sender: ALICE, at: LAUNCH + 2 })
    expect(result.verdict.kind).toBe('OK')
    expect(lookup(state, 'web3')?.owner).toBe(ALICE)
    expect(resolve(state, 'web3')).toBe(ALICE)
  })

  it('awards a short name straight to the recipient — the exchange-delegate use case (§6 U)', () => {
    const award = encodeUnreserve({ name: 'nq', recipient: BOB })
    expect(stepR(award, { sender: ADMIN }).verdict).toEqual({ kind: 'OK', obligations: [] })

    expect(state.unreserved.has('nq')).toBe(true)
    expect(lookup(state, 'nq')).toEqual({
      name: 'nq',
      owner: BOB,
      target: BOB,
      expiry: LAUNCH + CONSTANTS.TERM_LENGTH,
      status: 'REGISTERED',
      host: '',
      evm: '',
    })
    expect(resolve(state, 'nq')).toBe(BOB)
  })

  it('puts an awarded short name in the checkpoint tree as an ordinary leaf (§8.1)', () => {
    stepR(encodeUnreserve({ name: 'nq', recipient: BOB }), { sender: ADMIN })

    const proof = merkleProof(state, 'nq')
    expect(proof).not.toBeNull()
    expect(proof!.record.owner).toBe(BOB)
    expect(verifyProof(proof!.leaf, proof!.steps, merkleRoot(state))).toBe(true)
  })

  it('forfeits a name that is not reserved, or whose U has already fired', () => {
    expect(stepR(encodeUnreserve({ name: 'kikename' }), { sender: ADMIN }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'NAME_NOT_RESERVED',
    })

    stepR(unreserve(), { sender: ADMIN })
    expect(stepR(unreserve(), { sender: ADMIN, at: LAUNCH + 1 }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'NAME_NOT_RESERVED',
    })
  })

  it('gives a second release in the same block NAME_NOT_RESERVED, not UNRESERVE_PENDING (r22)', () => {
    // Through r21 the first U was *pending* and the second earned
    // UNRESERVE_PENDING. Executing on landing takes the name out of
    // RESERVED_NAMES in the first U's own block, so the second one fails the
    // reservation row like any other U naming a released name — which is why
    // UNRESERVE_PENDING left the vocabulary rather than merely going unused.
    expect(stepR(unreserve(), { sender: ADMIN }).verdict).toEqual({ kind: 'OK', obligations: [] })
    expect(stepR(unreserve(), { sender: ADMIN, txIndex: 1 }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'NAME_NOT_RESERVED',
    })
    // The first U's effect stands: a release, so no leaf.
    expect(lookup(state, 'binance')).toBeNull()
  })

  describe('an award reaches any name nobody owns (2026-09-11)', () => {
    it('awards a released name — an award after a release is a normal award of an available name', () => {
      expect(stepR(unreserve(), { sender: ADMIN }).verdict.kind).toBe('OK')
      expect(stepR(unreserve(BOB), { sender: ADMIN, txIndex: 1 }).verdict).toEqual({ kind: 'OK', obligations: [] })
      expect(lookup(state, 'binance')).toMatchObject({ owner: BOB, target: BOB, status: 'REGISTERED' })
    })

    it('awards a plain AVAILABLE name that was never reserved, and leaves the unreserved set alone', () => {
      const award = encodeUnreserve({ name: 'kikename', recipient: BOB })
      expect(stepR(award, { sender: ADMIN, at: LAUNCH + 3 }).verdict).toEqual({ kind: 'OK', obligations: [] })
      expect(lookup(state, 'kikename')).toEqual({
        name: 'kikename',
        owner: BOB,
        target: BOB,
        expiry: LAUNCH + 3 + CONSTANTS.TERM_LENGTH,
        status: 'REGISTERED',
        host: '',
        evm: '',
      })
      // Tag 0x0A records governance acts on RESERVED_NAMES; a name that was
      // never in the set has nothing to record (§6 U, §8.1).
      expect(state.unreserved.has('kikename')).toBe(false)
      // Nothing owed and nothing earned: no obligation, no fee.
      expect(state.outstanding.size).toBe(0)
    })

    it('forfeits NAME_NOT_AVAILABLE for a REGISTERED or a GRACE name — no U touches a held name (§10.6)', () => {
      registerToAlice('kikename', LAUNCH)
      expect(stepR(encodeUnreserve({ name: 'kikename', recipient: BOB }), { sender: ADMIN, at: LAUNCH + 1 }).verdict).toEqual({
        kind: 'FORFEIT',
        reason: 'NAME_NOT_AVAILABLE',
      })
      state = advanceTo(state, LAUNCH + CONSTANTS.TERM_LENGTH)
      expect(lookup(state, 'kikename')?.status).toBe('GRACE')
      expect(
        stepR(encodeUnreserve({ name: 'kikename', recipient: BOB }), { sender: ADMIN, at: LAUNCH + CONSTANTS.TERM_LENGTH })
          .verdict,
      ).toEqual({ kind: 'FORFEIT', reason: 'NAME_NOT_AVAILABLE' })
      expect(lookup(state, 'kikename')?.owner).toBe(ALICE)
    })

    it('gives a second award NAME_NOT_AVAILABLE and a release after an award NAME_NOT_RESERVED', () => {
      expect(stepR(unreserve(BOB), { sender: ADMIN }).verdict.kind).toBe('OK')
      expect(stepR(unreserve(CAROL), { sender: ADMIN, txIndex: 1 }).verdict).toEqual({
        kind: 'FORFEIT',
        reason: 'NAME_NOT_AVAILABLE',
      })
      expect(stepR(unreserve(), { sender: ADMIN, txIndex: 2 }).verdict).toEqual({
        kind: 'FORFEIT',
        reason: 'NAME_NOT_RESERVED',
      })
      expect(lookup(state, 'binance')?.owner).toBe(BOB)
    })

    it('awards a lifetime with |L — a hundred terms, still a plain expiry (§10.4)', () => {
      const award = encodeUnreserve({ name: 'nq', recipient: BOB, lifetime: true })
      expect(stepR(award, { sender: ADMIN, at: LAUNCH + 7 }).verdict).toEqual({ kind: 'OK', obligations: [] })
      expect(lookup(state, 'nq')).toMatchObject({
        owner: BOB,
        expiry: LAUNCH + 7 + CONSTANTS.LIFETIME_TERMS * CONSTANTS.TERM_LENGTH,
        status: 'REGISTERED',
      })
      expect(state.unreserved.has('nq')).toBe(true)
    })

    it('ignores |L on a release — there is no term to set', () => {
      // The builder refuses this shape, so the payload is written by hand.
      const built: BuiltTransaction = { ...unreserve(), data: hexOf('NNS1Ubinance|L') }
      expect(stepR(built, { sender: ADMIN }).verdict).toEqual({ kind: 'OK', obligations: [] })
      expect(state.unreserved.has('binance')).toBe(true)
      expect(lookup(state, 'binance')).toBeNull()
    })

    it('prices a released short name by its own band from then on — 200× for two characters', () => {
      expect(stepR(encodeUnreserve({ name: 'nq' }), { sender: ADMIN }).verdict.kind).toBe('OK')
      const band = feeFor('nq', LAUNCH_PRICES)
      expect(band).toBe(CONSTANTS.FEE_BASE * 200n)
      expect(stepR(encodeRegister({ name: 'nq', fee: band - 1n }), { sender: ALICE, at: LAUNCH + 1 }).verdict).toMatchObject({
        kind: 'REFUND',
        reason: 'INSUFFICIENT_VALUE',
      })
      expect(stepR(encodeRegister({ name: 'nq', fee: band }), { sender: ALICE, at: LAUNCH + 1 }).verdict.kind).toBe('OK')
      // Renewal reads the same band, and the lifetime upgrade ten of them.
      expect(stepR(encodeRenew({ name: 'nq', fee: FEE }), { sender: ALICE, at: LAUNCH + 2 }).verdict).toMatchObject({
        kind: 'REFUND',
        reason: 'INSUFFICIENT_VALUE',
      })
      expect(stepR(encodeRenew({ name: 'nq', fee: band }), { sender: ALICE, at: LAUNCH + 2 }).verdict.kind).toBe('OK')
      expect(feeFor('nq', LAUNCH_PRICES, true)).toBe(band * 10n)
      expect(
        stepR(encodeRenew({ name: 'nq', fee: band * 10n, lifetime: true }), { sender: BOB, at: LAUNCH + 3 }).verdict.kind,
      ).toBe('OK')
      expect(lookup(state, 'nq')?.expiry).toBe(LAUNCH + 1 + (2 + CONSTANTS.LIFETIME_TERMS) * CONSTANTS.TERM_LENGTH)
    })
  })

  it('releases in its own block, with no scheduled effect left behind', () => {
    stepR(unreserve(), { sender: ADMIN })
    expect(state.unreserved.has('binance')).toBe(true)
    expect(lookup(state, 'binance')).toBeNull()
    // Nothing was scheduled: a U leaves no due height of its own.
    expect(state.nextDueHeight).toBe(Number.POSITIVE_INFINITY)
  })

  it('registers a released name with a builder-built G — the builder must not reject on the static list', () => {
    stepR(unreserve(), { sender: ADMIN })

    // encodeRegister sees the same config that reserves `binance`; released-ness
    // lives in state.unreserved, which only the reducer can consult.
    const result = stepR(encodeRegister({ name: 'binance', fee: FEE }), { sender: ALICE, at: LAUNCH, txIndex: 1 })
    expect(result.verdict.kind).toBe('OK')
    expect(lookup(state, 'binance')?.owner).toBe(ALICE)
    expect(resolve(state, 'binance')).toBe(ALICE)
  })

  it('awards straight to the recipient on landing, never through AVAILABLE', () => {
    expect(stepR(unreserve(BOB), { sender: ADMIN }).verdict).toEqual({ kind: 'OK', obligations: [] })

    expect(state.unreserved.has('binance')).toBe(true)
    expect(lookup(state, 'binance')).toEqual({
      name: 'binance',
      owner: BOB,
      target: BOB,
      expiry: LAUNCH + CONSTANTS.TERM_LENGTH,
      status: 'REGISTERED',
      host: '',
      evm: '',
    })
    expect(resolve(state, 'binance')).toBe(BOB)
  })

  it('an award beats the Gs behind it in its own block, and loses to the ones ahead (§6 U, r22)', () => {
    // Ahead of the U the name is still reserved…
    expect(stepR(encodeRegister({ name: 'binance', fee: FEE }), { sender: ALICE, at: LAUNCH }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'RESERVED_NAME',
    })
    stepR(unreserve(BOB), { sender: ADMIN, at: LAUNCH, txIndex: 1 })
    // …and behind it the name is REGISTERED, so this is a concurrency loss.
    // Through r21 the award fired in §7.3's height-driven step and beat *every*
    // G in its block; it now beats the ones behind it.
    expect(
      stepR(encodeRegister({ name: 'binance', fee: FEE }), { sender: ALICE, at: LAUNCH, txIndex: 2 }).verdict,
    ).toMatchObject({ kind: 'REFUND', reason: 'LOST_REGISTRATION_RACE' })
    expect(lookup(state, 'binance')?.owner).toBe(BOB)
  })
})

// ── A and F ─────────────────────────────────────────────────────────────────

describe('A — auction (§6, r28)', () => {
  const STARTING_PRICE = 100_000_000n
  /** Far enough out that an `A` landing anywhere in the first ten blocks clears `AUCTION_MIN_DURATION`. */
  const END = LAUNCH + 10 + CONSTANTS.AUCTION_MIN_DURATION
  const auctionOf = (name = 'kikename', startingPrice = STARTING_PRICE, endHeight = END): BuiltTransaction =>
    encodeAuction({ name, startingPrice, endHeight, minPrice: FLOOR })
  const bid = (price: bigint, sender: Address, at: number, txIndex = 0): ReduceResult =>
    step(encodeBuy({ name: 'kikename', price }), { sender, at, txIndex })
  const legsOf = (result: ReduceResult) => (result.verdict as { obligations?: readonly unknown[] }).obligations

  it('requiredBid: the starting price until a bid stands, then standing + ⌊standing × AUCTION_MIN_INCREMENT⌋', () => {
    const open = { name: 'kikename', seller: ALICE, startingPrice: STARTING_PRICE, endHeight: END, bidder: null, bid: 0n, bidRef: null } as const
    const standing = (bid: bigint) => ({ ...open, bidder: BOB, bid, bidRef: { height: LAUNCH + 3, txIndex: 0 } })
    expect(requiredBid(open)).toBe(STARTING_PRICE)
    expect(requiredBid(standing(100n))).toBe(105n)
    expect(requiredBid(standing(100_000n))).toBe(105_000n)
    expect(requiredBid(standing(101n))).toBe(106n) // ⌊5.05⌋ = 5
    // Below 20 luna the increment rounds to zero and a bid could "raise" by
    // nothing — which is why the starting price floor is MIN_PRICE and not a token (§6 A).
    expect(requiredBid(standing(19n))).toBe(19n)
  })

  describe('opening', () => {
    it('opens for the owner, with no standing bid and the end as stated', () => {
      registerToAlice()
      const result = step(auctionOf(), { sender: ALICE, at: LAUNCH + 1 })
      expect(result.verdict).toEqual({ kind: 'OK', obligations: [] })
      expect(state.auctions.get('kikename')).toEqual({
        name: 'kikename',
        seller: ALICE,
        startingPrice: STARTING_PRICE,
        endHeight: END,
        bidder: null,
        bid: 0n,
        bidRef: null,
      })
      expect(state.nextDueHeight).toBeLessThanOrEqual(END)
    })

    it('routes to PROTOCOL_ADDRESS, before anything else', () => {
      registerToAlice()
      const built = { ...auctionOf(), recipient: TREASURY }
      expect(step(built, { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'WRONG_RECIPIENT' })
    })

    it('forfeits NAME_NOT_REGISTERED for a grace name and NOT_OWNER for a stranger', () => {
      registerToAlice()
      expect(step(auctionOf(), { sender: BOB, at: LAUNCH + 1 }).verdict).toEqual({ kind: 'FORFEIT', reason: 'NOT_OWNER' })
      const expiry = LAUNCH + CONSTANTS.TERM_LENGTH
      expect(
        step(auctionOf('kikename', STARTING_PRICE, expiry + CONSTANTS.AUCTION_MIN_DURATION), { sender: ALICE, at: expiry })
          .verdict,
      ).toEqual({ kind: 'FORFEIT', reason: 'NAME_NOT_REGISTERED' })
    })

    it('forfeits NAME_NOT_FOUND for an unregistered ordinary name, NOT_ADMIN for a held one from a stranger', () => {
      expect(step(auctionOf(), { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'NAME_NOT_FOUND' })
      expect(step(auctionOf('nim'), { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'NOT_ADMIN' })
      // A released short name has no record and is no longer held: NAME_NOT_FOUND, even from the admin.
      step(encodeUnreserve({ name: 'nim', recipient: null }), { sender: ADMIN })
      expect(step(auctionOf('nim'), { sender: ADMIN, at: LAUNCH + 1 }).verdict).toEqual({
        kind: 'FORFEIT',
        reason: 'NAME_NOT_FOUND',
      })
    })

    it('forfeits AUCTION_OPEN on a second A, BELOW_MIN_PRICE under the floor, INSUFFICIENT_NOTICE under the duration', () => {
      registerToAlice()
      // The builder refuses a below-floor starting price, so the probe is hand-built.
      const belowFloor = { ...auctionOf(), data: hexOf(`NNS1Akikename|${FLOOR - 1n}|${END}`) }
      expect(step(belowFloor, { sender: ALICE, at: LAUNCH + 1 }).verdict).toEqual({
        kind: 'FORFEIT',
        reason: 'BELOW_MIN_PRICE',
      })
      expect(step(auctionOf('kikename', STARTING_PRICE, LAUNCH + CONSTANTS.AUCTION_MIN_DURATION), { sender: ALICE, at: LAUNCH + 1 }).verdict).toEqual({
        kind: 'FORFEIT',
        reason: 'INSUFFICIENT_NOTICE',
      })
      expect(step(auctionOf('kikename', FLOOR), { sender: ALICE, at: LAUNCH + 2 }).verdict.kind).toBe('OK')
      expect(step(auctionOf(), { sender: ALICE, at: LAUNCH + 3 }).verdict).toEqual({ kind: 'FORFEIT', reason: 'AUCTION_OPEN' })
    })

    // Two tests rather than one since r30: an offer and a pending `X` can no
    // longer stand together, so a single name cannot present the auction with
    // both to void. Written apart on purpose — the one-name version still
    // passed after r30, because the `O` had already voided the `X` before the
    // `A` arrived, and a test that goes green without touching its subject is
    // worse than no test.
    it('voids the owner’s own pending X — the latest statement of intent wins', () => {
      registerToAlice()
      step(encodeTransfer({ name: 'kikename', newOwner: CAROL }), { sender: ALICE, at: LAUNCH + 1 })
      expect(state.transfers.has('kikename')).toBe(true)
      expect(step(auctionOf(), { sender: ALICE, at: LAUNCH + 3 }).verdict.kind).toBe('OK')
      expect(state.transfers.has('kikename')).toBe(false)
      // And the voided X never matures.
      state = advanceTo(state, LAUNCH + 1 + CONSTANTS.XFER_TIMELOCK)
      expect(lookup(state, 'kikename')?.owner).toEqual(ALICE)
    })

    it('voids the owner’s own open O', () => {
      registerToAlice()
      step(encodeOffer({ name: 'kikename', price: STARTING_PRICE, minPrice: FLOOR }), { sender: ALICE, at: LAUNCH + 2 })
      expect(state.offers.has('kikename')).toBe(true)
      expect(step(auctionOf(), { sender: ALICE, at: LAUNCH + 3 }).verdict.kind).toBe('OK')
      expect(state.offers.has('kikename')).toBe(false)
    })

    it('is exclusive while open: O and X forfeit AUCTION_OPEN, K finds nothing to cancel', () => {
      registerToAlice()
      step(auctionOf(), { sender: ALICE, at: LAUNCH + 1 })
      expect(step(encodeOffer({ name: 'kikename', price: STARTING_PRICE, minPrice: FLOOR }), { sender: ALICE, at: LAUNCH + 2 }).verdict).toEqual({
        kind: 'FORFEIT',
        reason: 'AUCTION_OPEN',
      })
      expect(step(encodeTransfer({ name: 'kikename', newOwner: CAROL }), { sender: ALICE, at: LAUNCH + 2 }).verdict).toEqual({
        kind: 'FORFEIT',
        reason: 'AUCTION_OPEN',
      })
      expect(step(encodeCancel({ name: 'kikename' }), { sender: ALICE, at: LAUNCH + 2 }).verdict).toEqual({
        kind: 'FORFEIT',
        reason: 'NOTHING_TO_CANCEL',
      })
      // Signalling that a transfer would reset anyway stays allowed.
      expect(step(encodeSetTarget({ name: 'kikename', target: CAROL }), { sender: ALICE, at: LAUNCH + 2 }).verdict.kind).toBe('OK')
    })
  })

  describe('bidding', () => {
    beforeEach(() => {
      registerToAlice()
      step(auctionOf(), { sender: ALICE, at: LAUNCH + 1 })
    })

    it('refunds a first bid under the starting price as WRONG_PRICE, and takes one at the starting price', () => {
      const low = bid(STARTING_PRICE - 1n, BOB, LAUNCH + 2)
      expect(low.verdict).toMatchObject({ kind: 'REFUND', reason: 'WRONG_PRICE' })
      expect(legsOf(low)).toEqual([
        { ref: { height: LAUNCH + 2, txIndex: 0 }, kind: 'REFUND', owedBy: MARKETPLACE, owedTo: BOB, amount: STARTING_PRICE - 1n },
      ])
      expect(state.auctions.get('kikename')?.bidder).toBeNull()

      const first = bid(STARTING_PRICE, BOB, LAUNCH + 3)
      expect(first.verdict).toEqual({ kind: 'OK', obligations: [] })
      expect(state.auctions.get('kikename')).toMatchObject({ bidder: BOB, bid: STARTING_PRICE, bidRef: { height: LAUNCH + 3, txIndex: 0 } })
      // Ownership has not moved — that is the close's job.
      expect(lookup(state, 'kikename')?.owner).toEqual(ALICE)
    })

    it('requires the standing bid plus 5%, floored, and refunds the outbid bidder at once by their own ref', () => {
      bid(STARTING_PRICE, BOB, LAUNCH + 3)
      const increment = commissionOn(STARTING_PRICE, CONSTANTS.AUCTION_MIN_INCREMENT_BP)
      expect(increment).toBe(5_000_000n)

      const short = bid(STARTING_PRICE + increment - 1n, CAROL, LAUNCH + 4)
      expect(short.verdict).toMatchObject({ kind: 'REFUND', reason: 'WRONG_PRICE' })
      expect(state.auctions.get('kikename')?.bidder).toEqual(BOB)

      const raise = bid(STARTING_PRICE + increment, CAROL, LAUNCH + 5)
      expect(raise.verdict).toEqual({
        kind: 'OK',
        obligations: [{ ref: { height: LAUNCH + 3, txIndex: 0 }, kind: 'REFUND', owedBy: MARKETPLACE, owedTo: BOB, amount: STARTING_PRICE }],
      })
      expect(state.outstanding.get(`${LAUNCH + 3}:0`)).toHaveLength(1)
      expect(state.auctions.get('kikename')).toMatchObject({ bidder: CAROL, bid: STARTING_PRICE + increment })
    })

    it('extends the end only when a successful bid lands inside AUCTION_EXTENSION of it', () => {
      const ext = CONSTANTS.AUCTION_EXTENSION
      bid(STARTING_PRICE, BOB, END - ext)
      expect(state.auctions.get('kikename')?.endHeight).toBe(END)
      // One block later the bid + extension exceeds the end by one.
      bid(STARTING_PRICE * 2n, CAROL, END - ext + 1)
      expect(state.auctions.get('kikename')?.endHeight).toBe(END + 1)
      // A refunded bid moves nothing.
      bid(STARTING_PRICE * 2n, BOB, END)
      expect(state.auctions.get('kikename')?.endHeight).toBe(END + 1)
      expect(state.nextDueHeight).toBe(END + 1)
    })

    it('refunds a B that arrives after the close as OFFER_NOT_OPEN, the ordinary no-offer path', () => {
      bid(STARTING_PRICE, BOB, LAUNCH + 3)
      const late = bid(STARTING_PRICE * 2n, CAROL, END)
      expect(late.verdict).toMatchObject({ kind: 'REFUND', reason: 'OFFER_NOT_OPEN' })
      expect(lookup(state, 'kikename')?.owner).toEqual(BOB)
    })
  })

  describe('closing', () => {
    it('an end pushed onto the expiry by an extension: the expiry fires first (§7.3), the auction is cancelled and the bid refunded', () => {
      // An A may not *open* past the term (AUCTION_BEYOND_TERM, below), but a
      // late bid can still carry the end to the expiry itself. Decided
      // 2026-09-03: expiry wins, the seller keeps a grace name, the bidder gets
      // the money back — a winner never receives a name already in grace.
      registerToAlice()
      const expiry = LAUNCH + CONSTANTS.TERM_LENGTH
      const opened = expiry - CONSTANTS.AUCTION_EXTENSION - CONSTANTS.AUCTION_MIN_DURATION - 10
      step(auctionOf('kikename', STARTING_PRICE, expiry - 1), { sender: ALICE, at: opened })
      bid(STARTING_PRICE, BOB, expiry - CONSTANTS.AUCTION_EXTENSION) // extends to exactly `expiry`
      expect(state.auctions.get('kikename')?.endHeight).toBe(expiry)
      state = advanceTo(state, expiry)
      expect(state.auctions.has('kikename')).toBe(false)
      expect(lookup(state, 'kikename')).toMatchObject({ owner: ALICE, status: 'GRACE', expiry })
      expect(state.outstanding.get(`${expiry - CONSTANTS.AUCTION_EXTENSION}:0`)).toEqual([
        { ref: { height: expiry - CONSTANTS.AUCTION_EXTENSION, txIndex: 0 }, kind: 'REFUND', owedBy: MARKETPLACE, owedTo: BOB, amount: STARTING_PRICE },
      ])
    })

    it('an A whose end is at or past the expiry forfeits AUCTION_BEYOND_TERM, after the window rows', () => {
      registerToAlice()
      registerToAlice('othername')
      const expiry = LAUNCH + CONSTANTS.TERM_LENGTH
      expect(step(auctionOf('kikename', STARTING_PRICE, expiry), { sender: ALICE, at: LAUNCH + 1 }).verdict).toEqual({ kind: 'FORFEIT', reason: 'AUCTION_BEYOND_TERM' })
      expect(step(auctionOf('kikename', STARTING_PRICE, expiry + 1), { sender: ALICE, at: LAUNCH + 2 }).verdict).toEqual({ kind: 'FORFEIT', reason: 'AUCTION_BEYOND_TERM' })
      // One block inside the term opens.
      expect(step(auctionOf('kikename', STARTING_PRICE, expiry - 1), { sender: ALICE, at: expiry - CONSTANTS.AUCTION_MIN_DURATION - 5 }).verdict.kind).toBe('OK')
      // Too short *and* past the term: the window's length is judged first.
      expect(step(auctionOf('othername', STARTING_PRICE, expiry), { sender: ALICE, at: expiry - 10 }).verdict).toEqual({ kind: 'FORFEIT', reason: 'INSUFFICIENT_NOTICE' })
    })

    it('fires at exactly end_height, before that block’s transactions: transfer resets plus two legs by the winning ref', () => {
      registerToAlice()
      step(encodeDelegate({ name: 'kikename', host: 'a.com' }), { sender: ALICE, at: LAUNCH + 1 })
      step(auctionOf(), { sender: ALICE, at: LAUNCH + 2 })
      bid(STARTING_PRICE, BOB, LAUNCH + 3)

      state = advanceTo(state, END - 1)
      expect(state.auctions.has('kikename')).toBe(true)
      expect(lookup(state, 'kikename')?.owner).toEqual(ALICE)

      state = advanceTo(state, END)
      expect(state.auctions.has('kikename')).toBe(false)
      expect(lookup(state, 'kikename')).toMatchObject({ owner: BOB, target: BOB, host: '', evm: '', status: 'REGISTERED' })
      const commission = commissionOn(STARTING_PRICE, CONSTANTS.COMMISSION_RATE)
      expect(state.outstanding.get(`${LAUNCH + 3}:0`)).toEqual([
        { ref: { height: LAUNCH + 3, txIndex: 0 }, kind: 'SALE_PROCEEDS', owedBy: MARKETPLACE, owedTo: ALICE, amount: STARTING_PRICE - commission },
        { ref: { height: LAUNCH + 3, txIndex: 0 }, kind: 'COMMISSION', owedBy: MARKETPLACE, owedTo: TREASURY, amount: commission },
      ])

      // The legs discharge like any other (§6 M).
      step(encodeSettlement({ height: LAUNCH + 3, txIndex: 0, payee: ALICE, amount: STARTING_PRICE - commission }), {
        sender: MARKETPLACE,
        at: END + 1,
      })
      expect(state.outstanding.get(`${LAUNCH + 3}:0`)).toHaveLength(1)
    })

    it('ends with nothing owed and the name where it was when no bid met the starting price', () => {
      registerToAlice()
      step(auctionOf(), { sender: ALICE, at: LAUNCH + 1 })
      bid(STARTING_PRICE - 1n, BOB, LAUNCH + 2)
      state = advanceTo(state, END)
      expect(state.auctions.has('kikename')).toBe(false)
      expect(lookup(state, 'kikename')?.owner).toEqual(ALICE)
      expect(state.outstanding.size).toBe(1) // the under-startingPrice refund only
      // And the owner can open another.
      expect(step(auctionOf('kikename', STARTING_PRICE, END + CONSTANTS.AUCTION_MIN_DURATION), { sender: ALICE, at: END }).verdict.kind).toBe('OK')
    })

    it('charges the commission at the rate active at the close height — governance fires first', () => {
      registerToAlice()
      step(auctionOf(), { sender: ALICE, at: LAUNCH + 1 })
      bid(STARTING_PRICE, BOB, LAUNCH + 2)
      // A P effective exactly at END, moving the commission by the max step.
      const raised = CONSTANTS.COMMISSION_RATE + CONSTANTS.COMMISSION_MAX_STEP
      step(
        encodeGovernance({ feeBase: FLOOR, commissionBp: raised, effectiveHeight: END }),
        { sender: ADMIN, at: END - CONSTANTS.GOVERNANCE_DELAY },
      )
      state = advanceTo(state, END)
      expect(state.prices.commissionBp).toBe(raised)
      expect(state.outstanding.get(`${LAUNCH + 2}:0`)?.[1]?.amount).toBe(commissionOn(STARTING_PRICE, raised))
    })

    it('awards a still-reserved name on U’s terms: fresh term from the close, unreserved set, both legs to the treasury', () => {
      expect(step(auctionOf('nim'), { sender: ADMIN }).verdict).toEqual({ kind: 'OK', obligations: [] })
      expect(state.auctions.get('nim')?.seller).toEqual(TREASURY)
      step(encodeBuy({ name: 'nim', price: STARTING_PRICE }), { sender: BOB, at: LAUNCH + 1 })
      state = advanceTo(state, END)
      expect(lookup(state, 'nim')).toEqual({
        name: 'nim',
        owner: BOB,
        target: BOB,
        expiry: END + CONSTANTS.TERM_LENGTH,
        status: 'REGISTERED',
        host: '',
        evm: '',
      })
      expect(state.unreserved.has('nim')).toBe(true)
      const commission = commissionOn(STARTING_PRICE, CONSTANTS.COMMISSION_RATE)
      expect(state.outstanding.get(`${LAUNCH + 1}:0`)?.map((leg) => [leg.kind, leg.owedTo, leg.amount])).toEqual([
        ['SALE_PROCEEDS', TREASURY, STARTING_PRICE - commission],
        ['COMMISSION', TREASURY, commission],
      ])
    })

    it('is cancelled by the grace reset, refunding the standing bid, when the end falls past expiry', () => {
      registerToAlice()
      const expiry = LAUNCH + CONSTANTS.TERM_LENGTH
      const opened = expiry - CONSTANTS.AUCTION_MIN_DURATION + 1
      step(auctionOf('kikename', STARTING_PRICE, opened + CONSTANTS.AUCTION_MIN_DURATION), { sender: ALICE, at: opened })
      bid(STARTING_PRICE, BOB, opened + 1)
      state = advanceTo(state, expiry)
      expect(lookup(state, 'kikename')?.status).toBe('GRACE')
      expect(state.auctions.has('kikename')).toBe(false)
      expect(state.outstanding.get(`${opened + 1}:0`)).toEqual([
        { ref: { height: opened + 1, txIndex: 0 }, kind: 'REFUND', owedBy: MARKETPLACE, owedTo: BOB, amount: STARTING_PRICE },
      ])
    })
  })
})

describe('F — burn attestation (§6)', () => {
  it('is accepted from the treasury with no protocol effect', () => {
    const result = step(encodeBurn({ amount: 1_000n }), { sender: TREASURY })
    expect(result.verdict).toEqual({ kind: 'OK', obligations: [] })
    expect(state.names.size).toBe(0)
  })

  it('forfeits from anyone but the treasury', () => {
    expect(step(encodeBurn({ amount: 1_000n }), { sender: ALICE }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'WRONG_SENDER',
    })
  })
})

// ── Purity ──────────────────────────────────────────────────────────────────

describe('purity', () => {
  it('never mutates the state it was given', () => {
    const before = initialState()
    const snapshot = { names: before.names.size, height: before.height }
    reduce(before, send(encodeRegister({ name: 'kikename', fee: FEE }), { sender: ALICE, at: LAUNCH + 5 }), config)
    expect(before.names.size).toBe(snapshot.names)
    expect(before.height).toBe(snapshot.height)
  })

  it('returns a frozen state', () => {
    const result = reduce(state, send(encodeRegister({ name: 'kikename', fee: FEE }), { sender: ALICE }), config)
    expect(Object.isFrozen(result.state)).toBe(true)
  })

  it('is deterministic — the same input twice gives identical output', () => {
    const tx = send(encodeRegister({ name: 'kikename', fee: FEE }), { sender: ALICE, at: LAUNCH + 7 })
    const a = reduce(state, tx, config)
    const b = reduce(state, tx, config)
    expect([...a.state.names.entries()]).toEqual([...b.state.names.entries()])
    expect(a.verdict).toEqual(b.verdict)
  })
})

/** ASCII → hex, for messages the builders deliberately refuse to produce. */
function hexOf(text: string): string {
  return [...text].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')
}
