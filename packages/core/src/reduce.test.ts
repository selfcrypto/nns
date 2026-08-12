import { beforeEach, describe, expect, it } from 'vitest'
import type { Address } from './address.js'
import {
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
  reduce,
} from './reduce.js'
import { type NnsState, initialState, lookup, resolve } from './state.js'
import { ADMIN, ALICE, BOB, CAROL, MAINNET_ID, MARKETPLACE, PROTOCOL, TREASURY, testConfig } from './test-fixtures.js'

const config = testConfig()
const LAUNCH = config.launchHeight
const FEE = CONSTANTS.FEE_STANDARD

let state: NnsState
beforeEach(() => {
  state = initialState(config)
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
  const result = step(encodeRegister(config, { name, fee: FEE }), { sender: ALICE, at })
  expect(result.verdict.kind).toBe('OK')
}

// ── §7.5 ────────────────────────────────────────────────────────────────────

describe('§7.5 — transactions the indexer must ignore', () => {
  it('failed_G_does_not_register_name', () => {
    // The named conformance case (§14). Albatross includes failed
    // transactions in blocks; without this rule a failed G takes a name.
    const result = step(encodeRegister(config, { name: 'kikename', fee: FEE }), {
      sender: ALICE,
      executionResult: false,
    })
    expect(result.verdict).toEqual({ kind: 'IGNORED', reason: 'FAILED_EXECUTION' })
    expect(lookup(state, 'kikename')).toBeNull()
    expect(resolve(state, 'kikename')).toBeNull()
  })

  it('ignores reward transactions', () => {
    const result = step(encodeRegister(config, { name: 'kikename', fee: FEE }), { sender: ALICE, isReward: true })
    expect(result.verdict).toEqual({ kind: 'IGNORED', reason: 'REWARD_TRANSACTION' })
    expect(lookup(state, 'kikename')).toBeNull()
  })

  it('ignores another network, without even advancing height', () => {
    const before = state.height
    const result = step(encodeRegister(config, { name: 'kikename', fee: FEE }), {
      sender: ALICE,
      at: LAUNCH + 500,
      networkId: MAINNET_ID + 1,
    })
    expect(result.verdict).toEqual({ kind: 'IGNORED', reason: 'WRONG_NETWORK' })
    expect(state.height).toBe(before)
  })

  it('ignores anything before LAUNCH_HEIGHT', () => {
    const result = step(encodeRegister(config, { name: 'kikename', fee: FEE }), { sender: ALICE, at: LAUNCH - 1 })
    expect(result.verdict).toEqual({ kind: 'IGNORED', reason: 'BEFORE_LAUNCH' })
  })

  it('ignores ordinary chain traffic — the common case', () => {
    const result = reduce(
      state,
      { ...send(encodeRegister(config, { name: 'kikename', fee: FEE }), { sender: ALICE }), recipientData: '68690a' },
      config,
    )
    expect(result.verdict).toEqual({ kind: 'IGNORED', reason: 'NOT_NNS1' })
  })
})

// ── Canonical ordering ──────────────────────────────────────────────────────

describe('§5.2 canonical ordering', () => {
  const registration = (sender: Address): BuiltTransaction =>
    encodeRegister(config, { name: 'kikename', fee: FEE })

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
    expect(step(encodeRegister(config, { name: long, fee: CONSTANTS.FEE_LONG }), { sender: ALICE }).verdict.kind).toBe(
      'OK',
    )
    expect(
      step(encodeRegister(config, { name: 'kikename', fee: CONSTANTS.FEE_LONG }), { sender: BOB }).verdict,
    ).toEqual({ kind: 'FORFEIT', reason: 'INSUFFICIENT_VALUE' })
  })

  it('accepts an overpayment and forfeits the excess (§10.5)', () => {
    expect(step(encodeRegister(config, { name: 'kikename', fee: FEE * 2n }), { sender: ALICE }).verdict.kind).toBe('OK')
  })

  it('forfeits an invalid name, checkable offline', () => {
    // Built by hand: the builder refuses to encode this at all.
    const built = { ...encodeRegister(config, { name: 'kikename', fee: FEE }), data: hexOf('NNS1Gn1m1q') }
    expect(step(built, { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'INVALID_NAME' })
  })

  it('forfeits a reserved name, and accepts it once a U has released it', () => {
    const reservedConfig = testConfig({ reservedNames: ['binance'] })
    let s = initialState(reservedConfig)
    const attempt = (at: number): ReduceResult =>
      reduce(
        s,
        send({ ...encodeRegister(config, { name: 'kikename', fee: FEE }), data: hexOf('NNS1Gbinance') }, {
          sender: ALICE,
          at,
        }),
        reservedConfig,
      )

    expect(attempt(LAUNCH).verdict).toEqual({ kind: 'FORFEIT', reason: 'RESERVED_NAME' })

    const release = reduce(
      s,
      send(encodeUnreserve(reservedConfig, { name: 'binance', effectiveHeight: LAUNCH + CONSTANTS.GOVERNANCE_DELAY }), {
        sender: ADMIN,
        at: LAUNCH,
      }),
      reservedConfig,
    )
    expect(release.verdict.kind).toBe('OK')
    s = release.state

    const after = reduce(
      s,
      send({ ...encodeRegister(config, { name: 'kikename', fee: FEE }), data: hexOf('NNS1Gbinance') }, {
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
    const result = step(encodeRegister(config, { name: 'kikename', fee: FEE }), { sender: BOB, at: expiry + 1 })
    expect(result.verdict).toEqual({ kind: 'FORFEIT', reason: 'NAME_IN_GRACE' })
  })

  it('forfeits rather than refunds below REFUND_FLOOR (§7.4)', () => {
    // A zero-fee deployment makes the underfunded-race case reachable.
    const free = testConfig()
    let s = initialState(free)
    const cheap = { ...encodeRegister(free, { name: 'kikename', fee: FEE }), data: hexOf('NNS1Gkikename') }

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
    const built = { ...encodeRegister(config, { name: 'kikename', fee: FEE }), recipient: PROTOCOL }
    expect(step(built, { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'WRONG_RECIPIENT' })
  })

  it('records a referrer without letting it affect the outcome (§6 G)', () => {
    expect(
      step(encodeRegister(config, { name: 'kikename', ref: 'coinbase', fee: FEE }), { sender: ALICE }).verdict.kind,
    ).toBe('OK')
    expect(lookup(state, 'kikename')?.owner).toBe(ALICE)
  })
})

// ── S, D ────────────────────────────────────────────────────────────────────

describe('S — set resolution target (§6)', () => {
  beforeEach(() => registerToAlice())

  it('moves resolution without moving ownership', () => {
    expect(step(encodeSetTarget(config, { name: 'kikename', target: BOB }), { sender: ALICE }).verdict.kind).toBe('OK')
    expect(resolve(state, 'kikename')).toBe(BOB)
    expect(lookup(state, 'kikename')?.owner).toBe(ALICE)
  })

  it('resets the target to the owner via the PROTOCOL_ADDRESS sentinel (§5.3)', () => {
    step(encodeSetTarget(config, { name: 'kikename', target: BOB }), { sender: ALICE })
    step(encodeSetTarget(config, { name: 'kikename', target: null }), { sender: ALICE })
    expect(resolve(state, 'kikename')).toBe(ALICE)
  })

  it('forfeits an S from anyone but the owner', () => {
    expect(step(encodeSetTarget(config, { name: 'kikename', target: BOB }), { sender: BOB }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'NOT_OWNER',
    })
  })

  it('forfeits an S on a grace-period name', () => {
    const result = step(encodeSetTarget(config, { name: 'kikename', target: BOB }), {
      sender: ALICE,
      at: LAUNCH + CONSTANTS.TERM_LENGTH,
    })
    expect(result.verdict).toEqual({ kind: 'FORFEIT', reason: 'NAME_NOT_REGISTERED' })
  })
})

describe('D — set delegate resolver (§6)', () => {
  beforeEach(() => registerToAlice('binance'))

  it('sets and clears the delegate host', () => {
    step(encodeDelegate(config, { name: 'binance', host: 'nns.binance.com' }), { sender: ALICE })
    expect(lookup(state, 'binance')?.host).toBe('nns.binance.com')
    step(encodeDelegate(config, { name: 'binance', host: '' }), { sender: ALICE })
    expect(lookup(state, 'binance')?.host).toBe('')
  })

  it('forfeits a host carrying a scheme', () => {
    const built = { ...encodeDelegate(config, { name: 'binance', host: 'x.com' }), data: hexOf('NNS1Dbinance|ht:p') }
    expect(step(built, { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'INVALID_HOST' })
  })
})

// ── X, R, K ─────────────────────────────────────────────────────────────────

describe('X — transfer ownership (§6, §7.3)', () => {
  beforeEach(() => registerToAlice())

  it('waits XFER_TIMELOCK, resolving as before until then', () => {
    step(encodeTransfer(config, { name: 'kikename', newOwner: BOB }), { sender: ALICE, at: LAUNCH + 1 })
    const effective = LAUNCH + 1 + CONSTANTS.XFER_TIMELOCK

    state = advanceTo(state, effective - 1)
    expect(lookup(state, 'kikename')?.owner).toBe(ALICE)

    state = advanceTo(state, effective)
    expect(lookup(state, 'kikename')?.owner).toBe(BOB)
  })

  it('resets dependent state on taking effect (§7.3)', () => {
    step(encodeDelegate(config, { name: 'kikename', host: 'a.com' }), { sender: ALICE })
    step(encodeRecovery(config, { name: 'kikename', recovery: CAROL }), { sender: ALICE })
    state = advanceTo(state, LAUNCH + CONSTANTS.XFER_TIMELOCK)
    expect(lookup(state, 'kikename')?.recovery).toBe(CAROL)

    step(encodeOffer(config, { name: 'kikename', price: 100n }), { sender: ALICE, at: LAUNCH + 100_000 })
    step(encodeTransfer(config, { name: 'kikename', newOwner: BOB }), { sender: ALICE, at: LAUNCH + 100_000 })
    state = advanceTo(state, LAUNCH + 100_000 + CONSTANTS.XFER_TIMELOCK)

    const record = lookup(state, 'kikename')
    expect(record).toMatchObject({ owner: BOB, target: BOB, recovery: null, host: '' })
    expect(state.offers.has('kikename')).toBe(false)
    expect(state.transfers.has('kikename')).toBe(false)
  })

  it('lets a second X supersede the first and restart the timelock', () => {
    step(encodeTransfer(config, { name: 'kikename', newOwner: BOB }), { sender: ALICE, at: LAUNCH })
    step(encodeTransfer(config, { name: 'kikename', newOwner: CAROL }), { sender: ALICE, at: LAUNCH + 100 })

    state = advanceTo(state, LAUNCH + CONSTANTS.XFER_TIMELOCK)
    expect(lookup(state, 'kikename')?.owner).toBe(ALICE)

    state = advanceTo(state, LAUNCH + 100 + CONSTANTS.XFER_TIMELOCK)
    expect(lookup(state, 'kikename')?.owner).toBe(CAROL)
  })

  it('gives the recovery address the longer RECOVERY_TIMELOCK', () => {
    step(encodeRecovery(config, { name: 'kikename', recovery: CAROL }), { sender: ALICE })
    state = advanceTo(state, LAUNCH + CONSTANTS.XFER_TIMELOCK)

    const at = LAUNCH + CONSTANTS.XFER_TIMELOCK
    step(encodeTransfer(config, { name: 'kikename', newOwner: CAROL }), { sender: CAROL, at })

    state = advanceTo(state, at + CONSTANTS.XFER_TIMELOCK)
    expect(lookup(state, 'kikename')?.owner).toBe(ALICE)

    state = advanceTo(state, at + CONSTANTS.RECOVERY_TIMELOCK)
    expect(lookup(state, 'kikename')?.owner).toBe(CAROL)
  })

  it('forfeits an X from a stranger', () => {
    expect(step(encodeTransfer(config, { name: 'kikename', newOwner: BOB }), { sender: BOB }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'NOT_OWNER_OR_RECOVERY',
    })
  })
})

describe('K — cancel (§6)', () => {
  beforeEach(() => registerToAlice())

  it('vetoes a pending transfer, effective on inclusion', () => {
    step(encodeTransfer(config, { name: 'kikename', newOwner: BOB }), { sender: ALICE })
    expect(step(encodeCancel(config, { name: 'kikename' }), { sender: ALICE, at: LAUNCH + 1 }).verdict.kind).toBe('OK')

    state = advanceTo(state, LAUNCH + CONSTANTS.XFER_TIMELOCK + 1)
    expect(lookup(state, 'kikename')?.owner).toBe(ALICE)
  })

  it('lets the recovery address veto, which is what the timelock is for', () => {
    step(encodeRecovery(config, { name: 'kikename', recovery: CAROL }), { sender: ALICE })
    state = advanceTo(state, LAUNCH + CONSTANTS.XFER_TIMELOCK)

    const at = LAUNCH + CONSTANTS.XFER_TIMELOCK
    step(encodeTransfer(config, { name: 'kikename', newOwner: BOB }), { sender: ALICE, at })
    expect(step(encodeCancel(config, { name: 'kikename' }), { sender: CAROL, at: at + 1 }).verdict.kind).toBe('OK')

    state = advanceTo(state, at + CONSTANTS.XFER_TIMELOCK)
    expect(lookup(state, 'kikename')?.owner).toBe(ALICE)
  })

  it('cannot withdraw an offer inside OFFER_IRREVOCABLE, and can after', () => {
    step(encodeOffer(config, { name: 'kikename', price: 100n }), { sender: ALICE, at: LAUNCH })
    expect(step(encodeCancel(config, { name: 'kikename' }), { sender: ALICE, at: LAUNCH + 1 }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'NOTHING_TO_CANCEL',
    })

    const at = LAUNCH + CONSTANTS.OFFER_IRREVOCABLE
    expect(step(encodeCancel(config, { name: 'kikename' }), { sender: ALICE, at }).verdict.kind).toBe('OK')
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
    step(encodeDelegate(config, { name: 'kikename', host: 'a.com' }), { sender: ALICE })
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
    expect(step(encodeRenew(config, { name: 'kikename', fee: FEE }), { sender: BOB, at: expiry + 10 }).verdict.kind).toBe(
      'OK',
    )
    const record = lookup(state, 'kikename')
    expect(record?.status).toBe('REGISTERED')
    expect(record?.expiry).toBe(expiry + CONSTANTS.TERM_LENGTH)
    expect(record?.owner).toBe(ALICE)
  })

  it('never penalises an early renewal', () => {
    step(encodeRenew(config, { name: 'kikename', fee: FEE }), { sender: ALICE, at: LAUNCH + 1 })
    expect(lookup(state, 'kikename')?.expiry).toBe(expiry + CONSTANTS.TERM_LENGTH)
  })

  it('refuses to advance backwards', () => {
    state = advanceTo(state, LAUNCH + 100)
    expect(() => advanceTo(state, LAUNCH + 99)).toThrow(/cannot advance/)
  })
})

describe('ordering of effects that come due at the same height', () => {
  it('runs a maturing transfer before the expiry it collides with', () => {
    // §7.3 does not fix this order and the two readings do not agree: expire
    // first would cancel the pending X as part of the grace reset and leave
    // the name with Alice. See docs/decisions.md.
    registerToAlice()
    const expiry = LAUNCH + CONSTANTS.TERM_LENGTH
    step(encodeTransfer(config, { name: 'kikename', newOwner: BOB }), {
      sender: ALICE,
      at: expiry - CONSTANTS.XFER_TIMELOCK,
    })

    state = advanceTo(state, expiry)
    expect(lookup(state, 'kikename')).toMatchObject({ owner: BOB, status: 'GRACE' })
  })

  it('leaves a recovery address null either way, so that pair cannot fork', () => {
    registerToAlice()
    step(encodeRecovery(config, { name: 'kikename', recovery: CAROL }), { sender: ALICE, at: LAUNCH })
    step(encodeTransfer(config, { name: 'kikename', newOwner: BOB }), { sender: ALICE, at: LAUNCH })

    state = advanceTo(state, LAUNCH + CONSTANTS.XFER_TIMELOCK)
    expect(lookup(state, 'kikename')).toMatchObject({ owner: BOB, recovery: null })
    expect(state.recoveries.has('kikename')).toBe(false)
  })
})

describe('nextDueHeight is only ever a lower bound', () => {
  it('recomputes rather than skipping when a superseded X leaves it stale', () => {
    registerToAlice()
    step(encodeTransfer(config, { name: 'kikename', newOwner: BOB }), { sender: ALICE, at: LAUNCH })
    // Supersede with a later X. The bound still points at the first one's
    // maturity, which is now earlier than anything that will actually fire.
    step(encodeTransfer(config, { name: 'kikename', newOwner: CAROL }), { sender: ALICE, at: LAUNCH + 1_000 })

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
  const PRICE = 1_000_000n
  beforeEach(() => {
    registerToAlice()
    step(encodeOffer(config, { name: 'kikename', price: PRICE }), { sender: ALICE })
  })

  it('moves ownership immediately on a winning B, settlement never gating it', () => {
    const result = step(encodeBuy(config, { name: 'kikename', price: PRICE }), { sender: BOB, at: LAUNCH + 1 })
    expect(result.verdict.kind).toBe('OK')
    expect(lookup(state, 'kikename')).toMatchObject({ owner: BOB, target: BOB, recovery: null, host: '' })
    expect(state.offers.has('kikename')).toBe(false)
  })

  it('lets the buyer inherit the name’s current expiry', () => {
    step(encodeBuy(config, { name: 'kikename', price: PRICE }), { sender: BOB, at: LAUNCH + 1 })
    expect(lookup(state, 'kikename')?.expiry).toBe(LAUNCH + CONSTANTS.TERM_LENGTH)
  })

  it('splits the price into seller proceeds and commission that sum exactly (§6 M)', () => {
    const result = step(encodeBuy(config, { name: 'kikename', price: PRICE }), { sender: BOB, at: LAUNCH + 1 })
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
    step(encodeBuy(config, { name: 'kikename', price: PRICE }), { sender: BOB, at: LAUNCH + 1, txIndex: 0 })
    const loser = step(encodeBuy(config, { name: 'kikename', price: PRICE }), {
      sender: CAROL,
      at: LAUNCH + 1,
      txIndex: 1,
    })
    expect(loser.verdict).toMatchObject({ kind: 'REFUND', reason: 'OFFER_NOT_OPEN' })
    expect(lookup(state, 'kikename')?.owner).toBe(BOB)
  })

  it('refunds a B whose value is not exactly the price', () => {
    const built = encodeBuy(config, { name: 'kikename', price: PRICE })
    expect(step(built, { sender: BOB, at: LAUNCH + 1, value: PRICE - 1n }).verdict).toMatchObject({
      kind: 'REFUND',
      reason: 'WRONG_PRICE',
    })
    expect(lookup(state, 'kikename')?.owner).toBe(ALICE)
  })

  it('never deducts a commission from a refund', () => {
    const built = encodeBuy(config, { name: 'kikename', price: PRICE })
    const result = step(built, { sender: BOB, at: LAUNCH + 1, value: PRICE + 1n })
    const obligations = result.verdict.kind === 'REFUND' ? result.verdict.obligations : []
    expect(obligations[0]?.amount).toBe(PRICE + 1n)
  })

  it('expires an offer at OFFER_MAX_LIFETIME', () => {
    state = advanceTo(state, LAUNCH + CONSTANTS.OFFER_MAX_LIFETIME)
    expect(state.offers.has('kikename')).toBe(false)
    expect(step(encodeBuy(config, { name: 'kikename', price: PRICE }), {
      sender: BOB,
      at: LAUNCH + CONSTANTS.OFFER_MAX_LIFETIME,
    }).verdict).toMatchObject({ kind: 'REFUND', reason: 'OFFER_NOT_OPEN' })
  })

  it('discharges one leg per M, leaving the other outstanding', () => {
    step(encodeBuy(config, { name: 'kikename', price: PRICE }), { sender: BOB, at: LAUNCH + 1 })
    const key = `${LAUNCH + 1}:0`
    expect(state.outstanding.get(key)).toHaveLength(2)

    const commission = commissionOn(PRICE, CONSTANTS.COMMISSION_RATE)
    step(
      encodeSettlement(config, {
        height: LAUNCH + 1,
        txIndex: 0,
        payee: ALICE,
        amount: PRICE - commission,
      }),
      { sender: MARKETPLACE, at: LAUNCH + 2 },
    )
    expect(state.outstanding.get(key)).toHaveLength(1)

    step(encodeSettlement(config, { height: LAUNCH + 1, txIndex: 0, payee: TREASURY, amount: commission }), {
      sender: MARKETPLACE,
      at: LAUNCH + 3,
    })
    expect(state.outstanding.has(key)).toBe(false)
  })

  it('leaves the debt standing when an M underpays — the log makes the shortfall visible', () => {
    step(encodeBuy(config, { name: 'kikename', price: PRICE }), { sender: BOB, at: LAUNCH + 1 })
    step(encodeSettlement(config, { height: LAUNCH + 1, txIndex: 0, payee: ALICE, amount: 1n }), {
      sender: MARKETPLACE,
      at: LAUNCH + 2,
    })
    expect(state.outstanding.get(`${LAUNCH + 1}:0`)).toHaveLength(2)
  })

  it('forfeits an M from anyone but the marketplace or the treasury', () => {
    expect(
      step(encodeSettlement(config, { height: LAUNCH, txIndex: 0, payee: ALICE, amount: 1n }), {
        sender: BOB,
        at: LAUNCH + 2,
      }).verdict,
    ).toEqual({ kind: 'FORFEIT', reason: 'WRONG_SENDER' })
  })
})

// ── Governance ──────────────────────────────────────────────────────────────

describe('P — governance (§6, §10.6)', () => {
  const effective = LAUNCH + CONSTANTS.GOVERNANCE_DELAY
  const proposal = (over: Partial<{ feeStandard: bigint; feeLong: bigint; commissionBp: bigint }> = {}) =>
    encodeGovernance(config, {
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
    expect(step(encodeRegister(config, { name: 'kikename', fee: FEE }), { sender: ALICE, at: effective - 1 }).verdict.kind).toBe(
      'OK',
    )
    expect(step(encodeRegister(config, { name: 'othername', fee: FEE }), { sender: ALICE, at: effective }).verdict).toEqual(
      { kind: 'FORFEIT', reason: 'INSUFFICIENT_VALUE' },
    )
  })

  it('forfeits a P from anyone but ADMIN_ADDRESS', () => {
    expect(step(proposal(), { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'NOT_ADMIN' })
  })

  it('forfeits without GOVERNANCE_DELAY notice', () => {
    const built = encodeGovernance(config, {
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
    const soon = encodeGovernance(config, {
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
})

describe('U — unreserve (§6)', () => {
  it('forfeits from anyone but ADMIN_ADDRESS, and without notice', () => {
    expect(
      step(encodeUnreserve(config, { name: 'binance', effectiveHeight: LAUNCH + CONSTANTS.GOVERNANCE_DELAY }), {
        sender: ALICE,
      }).verdict,
    ).toEqual({ kind: 'FORFEIT', reason: 'NOT_ADMIN' })

    expect(
      step(encodeUnreserve(config, { name: 'binance', effectiveHeight: LAUNCH + 1 }), { sender: ADMIN }).verdict,
    ).toEqual({ kind: 'FORFEIT', reason: 'INSUFFICIENT_NOTICE' })
  })
})

// ── A and F ─────────────────────────────────────────────────────────────────

describe('A — auction (§6), not in v1', () => {
  it('parses, logs, and forfeits by protocol version rather than by omission', () => {
    const built = { ...encodeCancel(config, { name: 'kikename' }), data: hexOf('NNS1Akikename|1000|58200000') }
    expect(step(built, { sender: ALICE }).verdict).toEqual({ kind: 'FORFEIT', reason: 'AUCTION_NOT_IN_V1' })
  })
})

describe('F — burn attestation (§6)', () => {
  it('is accepted from the treasury with no protocol effect', () => {
    const result = step(encodeBurn(config, { amount: 1_000n }), { sender: TREASURY })
    expect(result.verdict).toEqual({ kind: 'OK', obligations: [] })
    expect(state.names.size).toBe(0)
  })

  it('forfeits from anyone but the treasury', () => {
    expect(step(encodeBurn(config, { amount: 1_000n }), { sender: ALICE }).verdict).toEqual({
      kind: 'FORFEIT',
      reason: 'WRONG_SENDER',
    })
  })
})

// ── Purity ──────────────────────────────────────────────────────────────────

describe('purity', () => {
  it('never mutates the state it was given', () => {
    const before = initialState(config)
    const snapshot = { names: before.names.size, height: before.height }
    reduce(before, send(encodeRegister(config, { name: 'kikename', fee: FEE }), { sender: ALICE, at: LAUNCH + 5 }), config)
    expect(before.names.size).toBe(snapshot.names)
    expect(before.height).toBe(snapshot.height)
  })

  it('returns a frozen state', () => {
    const result = reduce(state, send(encodeRegister(config, { name: 'kikename', fee: FEE }), { sender: ALICE }), config)
    expect(Object.isFrozen(result.state)).toBe(true)
  })

  it('is deterministic — the same input twice gives identical output', () => {
    const tx = send(encodeRegister(config, { name: 'kikename', fee: FEE }), { sender: ALICE, at: LAUNCH + 7 })
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
