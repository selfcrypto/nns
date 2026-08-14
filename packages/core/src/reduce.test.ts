import { beforeEach, describe, expect, it } from 'vitest'
import type { Address } from './address.js'
import {
  BURN_ADDRESS,
  type BuiltTransaction,
  encodeBurn,
  encodeBuy,
  encodeCancel,
  encodeDelegate,
  encodeGovernance,
  encodeOffer,
  encodeRecovery,
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
  governanceBoundViolation,
  reduce,
} from './reduce.js'
import { merkleProof, merkleRoot, verifyProof } from './merkle.js'
import { type NnsState, LAUNCH_PRICES, initialState, lookup, minPrice, resolve } from './state.js'
import { ADMIN, ALICE, BOB, CAROL, MAINNET_ID, MARKETPLACE, PROTOCOL, TREASURY, testConfig } from './test-fixtures.js'

const config = testConfig()
const LAUNCH: number = CONSTANTS.LAUNCH_HEIGHT
const FEE = CONSTANTS.FEE_STANDARD
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

describe('§5.2 canonical ordering', () => {
  const registration = (sender: Address): BuiltTransaction =>
    encodeRegister({ name: 'kikename', fee: FEE })

  it('gives the name to the earlier transaction in the block body array', () => {
    const first = step(registration(ALICE), { sender: ALICE, at: LAUNCH + 10, txIndex: 0 })
    const second = step(registration(BOB), { sender: BOB, at: LAUNCH + 10, txIndex: 1 })

    expect(first.verdict.kind).toBe('OK')
    expect(second.verdict).toMatchObject({ kind: 'REFUND', reason: 'LOST_REGISTRATION_RACE' })
    expect(lookup(state, 'kikename')?.owner).toBe(ALICE)
  })

  it('reverses when the two transactions swap positions — order is load-bearing', () => {
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
      recovery: null,
      host: '',
    })
    expect(resolve(state, 'kikename')).toBe(ALICE)
  })

  it('prices by length band, measured from the name itself (§10.1)', () => {
    const long = 'a'.repeat(CONSTANTS.LONG_NAME_LEN)
    expect(step(encodeRegister({ name: long, fee: CONSTANTS.FEE_LONG }), { sender: ALICE }).verdict.kind).toBe(
      'OK',
    )
    expect(
      step(encodeRegister({ name: 'kikename', fee: CONSTANTS.FEE_LONG }), { sender: BOB }).verdict,
    ).toEqual({ kind: 'FORFEIT', reason: 'INSUFFICIENT_VALUE' })
  })

  it('accepts an overpayment and forfeits the excess (§10.5)', () => {
    expect(step(encodeRegister({ name: 'kikename', fee: FEE * 2n }), { sender: ALICE }).verdict.kind).toBe('OK')
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
      send(encodeUnreserve({ name: 'binance', effectiveHeight: LAUNCH + CONSTANTS.GOVERNANCE_DELAY }), {
        sender: ADMIN,
        at: LAUNCH,
      }),
      reservedConfig,
    )
    expect(release.verdict.kind).toBe('OK')
    s = release.state

    const after = reduce(
      s,
      send({ ...encodeRegister({ name: 'kikename', fee: FEE }), data: hexOf('NNS1Gbinance') }, {
        sender: ALICE,
        at: LAUNCH + CONSTANTS.GOVERNANCE_DELAY,
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
    // Underpaid, so it never reaches the race: the forfeit column claims it
    // first, exactly as an underfunded message should be treated.
    expect(loser.verdict).toEqual({ kind: 'FORFEIT', reason: 'INSUFFICIENT_VALUE' })
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
    step(encodeDelegate({ name: 'kikename', host: 'a.com' }), { sender: ALICE })
    step(encodeRecovery({ name: 'kikename', recovery: CAROL }), { sender: ALICE })
    state = advanceTo(state, LAUNCH + CONSTANTS.XFER_TIMELOCK)
    expect(lookup(state, 'kikename')?.recovery).toBe(CAROL)

    const listed = encodeOffer({ name: 'kikename', price: FLOOR, minPrice: FLOOR })
    step(listed, { sender: ALICE, at: LAUNCH + 100_000 })
    step(encodeTransfer({ name: 'kikename', newOwner: BOB }), { sender: ALICE, at: LAUNCH + 100_000 })
    state = advanceTo(state, LAUNCH + 100_000 + CONSTANTS.XFER_TIMELOCK)

    const record = lookup(state, 'kikename')
    expect(record).toMatchObject({ owner: BOB, target: BOB, recovery: null, host: '' })
    expect(state.offers.has('kikename')).toBe(false)
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

  it('gives the recovery address the longer RECOVERY_TIMELOCK', () => {
    step(encodeRecovery({ name: 'kikename', recovery: CAROL }), { sender: ALICE })
    state = advanceTo(state, LAUNCH + CONSTANTS.XFER_TIMELOCK)

    const at = LAUNCH + CONSTANTS.XFER_TIMELOCK
    step(encodeTransfer({ name: 'kikename', newOwner: CAROL }), { sender: CAROL, at })

    state = advanceTo(state, at + CONSTANTS.XFER_TIMELOCK)
    expect(lookup(state, 'kikename')?.owner).toBe(ALICE)

    state = advanceTo(state, at + CONSTANTS.RECOVERY_TIMELOCK)
    expect(lookup(state, 'kikename')?.owner).toBe(CAROL)
  })

  it('forfeits an X from a stranger', () => {
    expect(step(encodeTransfer({ name: 'kikename', newOwner: BOB }), { sender: BOB }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'NOT_OWNER_OR_RECOVERY',
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

  it('lets the recovery address veto, which is what the timelock is for', () => {
    step(encodeRecovery({ name: 'kikename', recovery: CAROL }), { sender: ALICE })
    state = advanceTo(state, LAUNCH + CONSTANTS.XFER_TIMELOCK)

    const at = LAUNCH + CONSTANTS.XFER_TIMELOCK
    step(encodeTransfer({ name: 'kikename', newOwner: BOB }), { sender: ALICE, at })
    expect(step(encodeCancel({ name: 'kikename' }), { sender: CAROL, at: at + 1 }).verdict.kind).toBe('OK')

    state = advanceTo(state, at + CONSTANTS.XFER_TIMELOCK)
    expect(lookup(state, 'kikename')?.owner).toBe(ALICE)
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

  it('leaves a recovery address null either way, so that pair cannot fork', () => {
    registerToAlice()
    step(encodeRecovery({ name: 'kikename', recovery: CAROL }), { sender: ALICE, at: LAUNCH })
    step(encodeTransfer({ name: 'kikename', newOwner: BOB }), { sender: ALICE, at: LAUNCH })

    state = advanceTo(state, LAUNCH + CONSTANTS.XFER_TIMELOCK)
    expect(lookup(state, 'kikename')).toMatchObject({ owner: BOB, recovery: null })
    expect(state.recoveries.has('kikename')).toBe(false)
  })

  it('fires every §7.3 category due at one height, in §7.3 order, before that block’s transactions', () => {
    // One height with all seven categories due at once. §7.3 fixes the order —
    // governance, unreserve, maturing X, maturing R, expiry, grace release,
    // offer expiry — and fixes that the whole batch runs *before* the block's
    // own transactions, which is what the final `G` here checks.
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
    // An offer expiring at H.
    send1(encodeOffer({ name: 'offername', price: FLOOR, minPrice: FLOOR }), {
      sender: ALICE,
      at: H - CONSTANTS.OFFER_MAX_LIFETIME,
    })
    // A U and a P effective at H, and an X and an R maturing there — all four
    // sent at the same height, since GOVERNANCE_DELAY and XFER_TIMELOCK are equal.
    const notice = H - CONSTANTS.GOVERNANCE_DELAY
    send1(encodeUnreserve({ name: 'binance', effectiveHeight: H }), { sender: ADMIN, at: notice })
    send1(
      encodeGovernance({
        feeStandard: FEE * 2n,
        feeLong: CONSTANTS.FEE_LONG,
        commissionBp: CONSTANTS.COMMISSION_RATE,
        effectiveHeight: H,
      }),
      { sender: ADMIN, at: notice },
    )
    send1(encodeTransfer({ name: 'expirename', newOwner: BOB }), at(H - CONSTANTS.XFER_TIMELOCK))
    send1(encodeRecovery({ name: 'offername', recovery: CAROL }), at(H - CONSTANTS.XFER_TIMELOCK))

    state = advanceTo(state, H)

    expect(state.prices.feeStandard).toBe(FEE * 2n) // governance activated
    expect(state.unreserved.has('binance')).toBe(true) // unreserve activated
    expect(lookup(state, 'expirename')).toMatchObject({ owner: BOB, status: 'GRACE' }) // X before expiry
    expect(lookup(state, 'offername')?.recovery).toBe(CAROL) // R matured
    expect(lookup(state, 'gracename')).toBeNull() // grace released
    expect(state.offers.has('offername')).toBe(false) // offer expired

    // …and all of it before H's own transactions: this `G` is only registrable
    // because the `U` fired first, and only sufficient at the raised fee.
    expect(send1(registerBinance(FEE), at(H)).verdict).toEqual({ kind: 'FORFEIT', reason: 'INSUFFICIENT_VALUE' })
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
    expect(lookup(state, 'kikename')).toMatchObject({ owner: BOB, target: BOB, recovery: null, host: '' })
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

  it('moves the floor with FEE_LONG, reading it from state and not from constants', () => {
    // A P that doubles FEE_LONG doubles MIN_PRICE with it. An implementation
    // reading CONSTANTS.FEE_LONG is right until this block and wrong after.
    const effective = LAUNCH + CONSTANTS.GOVERNANCE_DELAY
    step(
      encodeGovernance({
        feeStandard: CONSTANTS.FEE_STANDARD,
        feeLong: FLOOR * 2n,
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
  const proposal = (over: Partial<{ feeStandard: bigint; feeLong: bigint; commissionBp: bigint }> = {}) =>
    encodeGovernance({
      feeStandard: CONSTANTS.FEE_STANDARD,
      feeLong: CONSTANTS.FEE_LONG,
      commissionBp: CONSTANTS.COMMISSION_RATE,
      effectiveHeight: effective,
      ...over,
    })

  it('takes effect only at effective_height, so nothing in flight is invalidated', () => {
    step(proposal({ feeStandard: CONSTANTS.FEE_STANDARD * 2n }), { sender: ADMIN })
    expect(state.prices.feeStandard).toBe(CONSTANTS.FEE_STANDARD)

    state = advanceTo(state, effective)
    expect(state.prices.feeStandard).toBe(CONSTANTS.FEE_STANDARD * 2n)
  })

  it('validates a registration against the price at its own block height', () => {
    step(proposal({ feeStandard: CONSTANTS.FEE_STANDARD * 2n }), { sender: ADMIN })
    expect(step(encodeRegister({ name: 'kikename', fee: FEE }), { sender: ALICE, at: effective - 1 }).verdict.kind).toBe(
      'OK',
    )
    expect(step(encodeRegister({ name: 'othername', fee: FEE }), { sender: ALICE, at: effective }).verdict).toEqual(
      { kind: 'FORFEIT', reason: 'INSUFFICIENT_VALUE' },
    )
  })

  it('forfeits a P from anyone but ADMIN_ADDRESS', () => {
    expect(step(proposal(), { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'NOT_ADMIN' })
  })

  it('forfeits without GOVERNANCE_DELAY notice', () => {
    const built = encodeGovernance({
      feeStandard: CONSTANTS.FEE_STANDARD,
      feeLong: CONSTANTS.FEE_LONG,
      commissionBp: CONSTANTS.COMMISSION_RATE,
      effectiveHeight: LAUNCH + CONSTANTS.GOVERNANCE_DELAY - 1,
    })
    expect(step(built, { sender: ADMIN }).verdict).toEqual({ kind: 'FORFEIT', reason: 'INSUFFICIENT_NOTICE' })
  })

  it.each([
    ['below PRICE_FLOOR', { feeStandard: 0n, feeLong: 0n }],
    ['above PRICE_CEILING', { feeStandard: CONSTANTS.PRICE_CEILING + 1n }],
    ['more than 2x up', { feeStandard: CONSTANTS.FEE_STANDARD * 3n }],
    ['more than 2x down', { feeStandard: CONSTANTS.FEE_STANDARD / 3n }],
    ['fee_long above fee_standard', { feeLong: CONSTANTS.FEE_STANDARD * 2n }],
    ['commission above the ceiling', { commissionBp: CONSTANTS.COMMISSION_CEILING + 1n }],
    ['commission step above the maximum', { commissionBp: CONSTANTS.COMMISSION_RATE + CONSTANTS.COMMISSION_MAX_STEP + 1n }],
  ])('forfeits a P %s', (_label, over) => {
    expect(step(proposal(over), { sender: ADMIN }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'GOVERNANCE_BOUND_VIOLATED',
    })
  })

  it('enforces PRICE_MIN_INTERVAL between accepted changes', () => {
    step(proposal({ feeStandard: CONSTANTS.FEE_STANDARD * 2n }), { sender: ADMIN })
    const soon = encodeGovernance({
      feeStandard: CONSTANTS.FEE_STANDARD * 2n,
      feeLong: CONSTANTS.FEE_LONG,
      commissionBp: CONSTANTS.COMMISSION_RATE,
      effectiveHeight: LAUNCH + 1 + CONSTANTS.GOVERNANCE_DELAY,
    })
    expect(step(soon, { sender: ADMIN, at: LAUNCH + 1 }).verdict).toEqual({ kind: 'FORFEIT', reason: 'TOO_SOON' })
  })

  it('bounds a compromised admin key to twelve visible halvings, not a catastrophe', () => {
    // §10.6: walking 4,000 NIM down to the 1 NIM floor takes twelve halvings,
    // each a publicly visible P separated by PRICE_MIN_INTERVAL.
    let fee = CONSTANTS.FEE_STANDARD
    let steps = 0
    while (fee > CONSTANTS.PRICE_FLOOR) {
      fee = fee / CONSTANTS.PRICE_MAX_FACTOR
      if (fee < CONSTANTS.PRICE_FLOOR) fee = CONSTANTS.PRICE_FLOOR
      steps++
    }
    expect(steps).toBe(12)
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
          feeStandard: CONSTANTS.FEE_STANDARD * 2n,
          feeLong: CONSTANTS.FEE_LONG * 2n,
          commissionBp: CONSTANTS.COMMISSION_RATE + CONSTANTS.COMMISSION_MAX_STEP,
        }),
      ).toBeNull()
    })

    it.each([
      ['PRICE_BAND', { feeStandard: 0n, feeLong: 0n }],
      ['ORDERING', { feeLong: CONSTANTS.FEE_STANDARD, feeStandard: CONSTANTS.FEE_STANDARD / 2n }],
      ['PRICE_MAX_FACTOR', { feeStandard: CONSTANTS.FEE_STANDARD * 3n }],
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

    it('states the window a price may move within, rounding the lower end up', () => {
      // The rule is `next × 2 >= previous`, so an odd previous permits one
      // luna more than a floor division would report.
      const odd = { ...launch, feeStandard: 400_000_001n }
      expect(governanceBoundViolation(odd, { ...odd, feeStandard: 200_000_000n })?.message).toContain(
        '200000001 … 800000002',
      )
      expect(governanceBoundViolation(odd, { ...odd, feeStandard: 200_000_001n })).toBeNull()
    })
  })
})

describe('U — unreserve (§6)', () => {
  // `binance` is on the frozen §4.1 published list (§3), not a fixture entry.
  const reserving = config
  const H = LAUNCH + CONSTANTS.GOVERNANCE_DELAY

  /** `step`, but against the config that reserves `binance`. */
  const stepR = (built: BuiltTransaction, options: SendOptions): ReduceResult => {
    const result = reduce(state, send(built, options), reserving)
    state = result.state
    return result
  }

  const unreserve = (recipient: Address | null = null): BuiltTransaction =>
    encodeUnreserve({ name: 'binance', effectiveHeight: H, recipient })

  beforeEach(() => {
    state = initialState()
  })

  it('forfeits from anyone but ADMIN_ADDRESS, and without notice', () => {
    expect(stepR(unreserve(), { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'NOT_ADMIN' })

    expect(
      stepR(encodeUnreserve({ name: 'binance', effectiveHeight: LAUNCH + 1 }), { sender: ADMIN }).verdict,
    ).toEqual({ kind: 'FORFEIT', reason: 'INSUFFICIENT_NOTICE' })
  })

  it('forfeits an award to BURN_ADDRESS, in its own row of the §7.4 order', () => {
    // The builder refuses to produce this, so the recipient is swapped by hand.
    const toBurn: BuiltTransaction = { ...unreserve(), recipient: BURN_ADDRESS }
    // NOT_ADMIN still comes first…
    expect(stepR(toBurn, { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'NOT_ADMIN' })
    // …then INVALID_RECIPIENT, *before* the notice check: the recipient
    // decides which of two operations the message even is (§7.4).
    const short: BuiltTransaction = {
      ...encodeUnreserve({ name: 'binance', effectiveHeight: LAUNCH + 1 }),
      recipient: BURN_ADDRESS,
    }
    expect(stepR(short, { sender: ADMIN }).verdict).toEqual({ kind: 'FORFEIT', reason: 'INVALID_RECIPIENT' })
  })

  it('forfeits a name failing §4.1 rules 2–5 or the ceiling — but the floor never binds a U', () => {
    // `ab-` fails rule 4 and is on neither §4.1 membership route, so no U may
    // release or award it. Built by hand: the builder refuses it too.
    const built: BuiltTransaction = { ...unreserve(), data: hexOf(`NNS1Uab-|${H}`) }
    expect(stepR(built, { sender: ADMIN }).verdict).toEqual({ kind: 'FORFEIT', reason: 'INVALID_NAME' })
  })

  it('releases a short name — reserved by rule, no list entry — and a later G registers it (r18)', () => {
    expect(stepR(encodeUnreserve({ name: 'web3', effectiveHeight: H }), { sender: ADMIN }).verdict).toEqual(
      { kind: 'OK', obligations: [] },
    )

    // Still held until the U fires: a G in the notice window forfeits.
    expect(
      stepR(encodeRegister({ name: 'web3', fee: FEE }), { sender: ALICE, at: LAUNCH + 1 }).verdict,
    ).toEqual({ kind: 'FORFEIT', reason: 'RESERVED_NAME' })

    state = advanceTo(state, H)
    expect(state.unreserved.has('web3')).toBe(true)

    // Released, the floor no longer binds (§4.1): a normal registration at
    // the normal STANDARD-band fee.
    const result = stepR(encodeRegister({ name: 'web3', fee: FEE }), { sender: ALICE, at: H })
    expect(result.verdict.kind).toBe('OK')
    expect(lookup(state, 'web3')?.owner).toBe(ALICE)
    expect(resolve(state, 'web3')).toBe(ALICE)
  })

  it('awards a short name straight to the recipient — the exchange-delegate use case (§6 U)', () => {
    const award = encodeUnreserve({ name: 'nq', effectiveHeight: H, recipient: BOB })
    expect(stepR(award, { sender: ADMIN }).verdict).toEqual({ kind: 'OK', obligations: [] })
    expect(state.pendingUnreserve.get('nq')).toEqual({ name: 'nq', recipient: BOB, effectiveHeight: H })

    state = advanceTo(state, H)
    expect(state.unreserved.has('nq')).toBe(true)
    expect(lookup(state, 'nq')).toEqual({
      name: 'nq',
      owner: BOB,
      target: BOB,
      expiry: H + CONSTANTS.TERM_LENGTH,
      status: 'REGISTERED',
      recovery: null,
      host: '',
    })
    expect(resolve(state, 'nq')).toBe(BOB)
  })

  it('puts an awarded short name in the checkpoint tree as an ordinary leaf (§8.1)', () => {
    stepR(encodeUnreserve({ name: 'nq', effectiveHeight: H, recipient: BOB }), { sender: ADMIN })
    state = advanceTo(state, H)

    const proof = merkleProof(state, 'nq')
    expect(proof).not.toBeNull()
    expect(proof!.record.owner).toBe(BOB)
    expect(verifyProof(proof!.leaf, proof!.steps, merkleRoot(state))).toBe(true)
  })

  it('forfeits a name that is not reserved, or whose U has already fired', () => {
    expect(
      stepR(encodeUnreserve({ name: 'kikename', effectiveHeight: H }), { sender: ADMIN }).verdict,
    ).toEqual({ kind: 'FORFEIT', reason: 'NAME_NOT_RESERVED' })

    stepR(unreserve(), { sender: ADMIN })
    const again = encodeUnreserve({
      name: 'binance',
      effectiveHeight: H + CONSTANTS.GOVERNANCE_DELAY,
    })
    expect(stepR(again, { sender: ADMIN, at: H }).verdict).toEqual({ kind: 'FORFEIT', reason: 'NAME_NOT_RESERVED' })
  })

  it('forfeits a second U while one is pending — nothing queues behind a pending U', () => {
    stepR(unreserve(), { sender: ADMIN })
    expect(stepR(unreserve(BOB), { sender: ADMIN, txIndex: 1 }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'UNRESERVE_PENDING',
    })
  })

  it('releases with no recipient recorded, and the name is AVAILABLE at effective_height', () => {
    stepR(unreserve(), { sender: ADMIN })
    expect(state.pendingUnreserve.get('binance')).toEqual({ name: 'binance', recipient: null, effectiveHeight: H })

    state = advanceTo(state, H)
    expect(state.pendingUnreserve.has('binance')).toBe(false)
    expect(state.unreserved.has('binance')).toBe(true)
    expect(lookup(state, 'binance')).toBeNull()
  })

  it('registers a released name with a builder-built G — the builder must not reject on the static list', () => {
    stepR(unreserve(), { sender: ADMIN })
    state = advanceTo(state, H)

    // encodeRegister sees the same config that reserves `binance`; released-ness
    // lives in state.unreserved, which only the reducer can consult.
    const result = stepR(encodeRegister({ name: 'binance', fee: FEE }), { sender: ALICE, at: H })
    expect(result.verdict.kind).toBe('OK')
    expect(lookup(state, 'binance')?.owner).toBe(ALICE)
    expect(resolve(state, 'binance')).toBe(ALICE)
  })

  it('awards straight to the recipient at effective_height, never through AVAILABLE', () => {
    expect(stepR(unreserve(BOB), { sender: ADMIN }).verdict).toEqual({ kind: 'OK', obligations: [] })
    expect(state.pendingUnreserve.get('binance')).toEqual({ name: 'binance', recipient: BOB, effectiveHeight: H })

    state = advanceTo(state, H)
    expect(state.unreserved.has('binance')).toBe(true)
    expect(lookup(state, 'binance')).toEqual({
      name: 'binance',
      owner: BOB,
      target: BOB,
      expiry: H + CONSTANTS.TERM_LENGTH,
      status: 'REGISTERED',
      recovery: null,
      host: '',
    })
    expect(resolve(state, 'binance')).toBe(BOB)
  })

  it('an award beats every G in the block it takes effect in — a refundable loss (§7.3)', () => {
    stepR(unreserve(BOB), { sender: ADMIN })
    // A sniper who saw the U coming, with a G prepared for the exact block: at
    // H the name is already REGISTERED, so this is a concurrency loss.
    const g = encodeRegister({ name: 'binance', fee: FEE })
    expect(stepR(g, { sender: ALICE, at: H }).verdict).toMatchObject({ kind: 'REFUND', reason: 'LOST_REGISTRATION_RACE' })
    expect(lookup(state, 'binance')?.owner).toBe(BOB)
  })
})

// ── A and F ─────────────────────────────────────────────────────────────────

describe('A — auction (§6), not in v1', () => {
  it('parses, logs, and forfeits by protocol version rather than by omission', () => {
    const built = { ...encodeCancel({ name: 'kikename' }), data: hexOf('NNS1Akikename|1000|58200000') }
    expect(step(built, { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'AUCTION_NOT_IN_V1' })
  })

  it('forfeits AUCTION_NOT_IN_V1 even below MIN_PRICE, because §6 requires that reason', () => {
    // §6 `A` gives the reserve the same MIN_PRICE floor, but every `A` in v1
    // takes this forfeit — a below-floor one answering `BELOW_MIN_PRICE`
    // instead would write a different reason code into the log than a
    // conforming implementation, and the log is committed to (§8.2).
    for (const reserve of [1n, FLOOR - 1n, FLOOR]) {
      const built = {
        ...encodeCancel({ name: 'kikename' }),
        data: hexOf(`NNS1Akikename|${reserve}|58200000`),
      }
      expect(step(built, { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'AUCTION_NOT_IN_V1' })
    }
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
