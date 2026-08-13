import { describe, expect, it } from 'vitest'
import {
  BURN_ADDRESS,
  CodecError,
  MESSAGE_TYPES,
  encodeAuction,
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
  parse,
  type Message,
} from './codec.js'
import { CONSTANTS } from './constants.js'
import { LAUNCH_PRICES, minPrice } from './state.js'
import { ALICE, BOB, MARKETPLACE, PROTOCOL, TREASURY, testConfig } from './test-fixtures.js'

const config = testConfig()
/** §3 `MIN_PRICE` at launch prices — the floor on an `O` price and an `A` reserve. */
const FLOOR = minPrice(LAUNCH_PRICES)

/** ASCII → lowercase hex, written independently of the implementation. */
const hex = (text: string): string =>
  [...text].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')

const parsed = (text: string): Message | null => {
  const result = parse(hex(text))
  return result.ok ? result.message : null
}

describe('the mainnet-verified known answer', () => {
  it('encodes NNS1Gtestname to 4e4e533147746573746e616d65 (CLAUDE.md, §5.1)', () => {
    const tx = encodeRegister(config, { name: 'testname', fee: CONSTANTS.FEE_STANDARD })
    expect(tx.data).toBe('4e4e533147746573746e616d65')
  })

  it('reads it back', () => {
    expect(parse('4e4e533147746573746e616d65')).toEqual({
      ok: true,
      message: { type: 'G', name: 'testname', ref: null },
    })
  })
})

describe('every message type round-trips encode → parse', () => {
  const cases: ReadonlyArray<readonly [string, { data: string }, Message]> = [
    ['G', encodeRegister(config, { name: 'kikename', fee: 1n }), { type: 'G', name: 'kikename', ref: null }],
    [
      'G with ref',
      encodeRegister(config, { name: 'kikename', ref: 'coinbase', fee: 1n }),
      { type: 'G', name: 'kikename', ref: 'coinbase' },
    ],
    ['S', encodeSetTarget(config, { name: 'kikename', target: BOB }), { type: 'S', name: 'kikename' }],
    ['S reset', encodeSetTarget(config, { name: 'kikename', target: null }), { type: 'S', name: 'kikename' }],
    ['X', encodeTransfer(config, { name: 'kikename', newOwner: BOB }), { type: 'X', name: 'kikename' }],
    ['R', encodeRecovery(config, { name: 'kikename', recovery: BOB }), { type: 'R', name: 'kikename' }],
    ['R clear', encodeRecovery(config, { name: 'kikename', recovery: null }), { type: 'R', name: 'kikename' }],
    [
      'D',
      encodeDelegate(config, { name: 'binance', host: 'nns.binance.com' }),
      { type: 'D', name: 'binance', host: 'nns.binance.com' },
    ],
    ['D clear', encodeDelegate(config, { name: 'binance', host: '' }), { type: 'D', name: 'binance', host: '' }],
    ['K', encodeCancel(config, { name: 'kikename' }), { type: 'K', name: 'kikename' }],
    ['N', encodeRenew(config, { name: 'kikename', fee: 1n }), { type: 'N', name: 'kikename' }],
    [
      'O',
      encodeOffer(config, { name: 'kikename', price: 123_456_789n, minPrice: FLOOR }),
      { type: 'O', name: 'kikename', price: 123_456_789n },
    ],
    ['B', encodeBuy(config, { name: 'kikename', price: 5n }), { type: 'B', name: 'kikename' }],
    [
      'M',
      encodeSettlement(config, { height: 58_060_800, txIndex: 0, payee: BOB, amount: 7n }),
      { type: 'M', height: 58_060_800, txIndex: 0 },
    ],
    [
      'A',
      encodeAuction(config, { name: 'kikename', reserve: 40_000_000n, endHeight: 58_200_000, minPrice: FLOOR }),
      { type: 'A', name: 'kikename', reserve: 40_000_000n, endHeight: 58_200_000 },
    ],
    [
      'P',
      encodeGovernance(config, {
        feeStandard: CONSTANTS.FEE_STANDARD,
        feeLong: CONSTANTS.FEE_LONG,
        commissionBp: 250n,
        effectiveHeight: 58_100_000,
      }),
      {
        type: 'P',
        feeStandard: CONSTANTS.FEE_STANDARD,
        feeLong: CONSTANTS.FEE_LONG,
        commissionBp: 250n,
        effectiveHeight: 58_100_000,
      },
    ],
    [
      'U',
      encodeUnreserve(config, { name: 'binance', effectiveHeight: 58_100_000 }),
      { type: 'U', name: 'binance', effectiveHeight: 58_100_000 },
    ],
    ['F', encodeBurn(config, { amount: 1_000n }), { type: 'F' }],
  ]

  it.each(cases)('%s', (_label, tx, expected) => {
    expect(parse(tx.data)).toEqual({ ok: true, message: expected })
  })

  it('covers all 14 types', () => {
    const covered = new Set(cases.map(([, , message]) => message.type))
    expect([...covered].sort()).toEqual([...MESSAGE_TYPES].sort())
  })

  it('emits lowercase hex only', () => {
    for (const [, tx] of cases) expect(tx.data).toMatch(/^[0-9a-f]+$/)
  })
})

describe('routing and value — §5.3, §5.4', () => {
  it('sends fee-bearing messages to the treasury', () => {
    expect(encodeRegister(config, { name: 'kikename', fee: 400n }).recipient).toBe(TREASURY)
    expect(encodeRenew(config, { name: 'kikename', fee: 400n }).recipient).toBe(TREASURY)
    expect(encodeOffer(config, { name: 'kikename', price: FLOOR, minPrice: FLOOR }).recipient).toBe(TREASURY)
  })

  it('sends dust-only signalling to the protocol address', () => {
    for (const tx of [
      encodeCancel(config, { name: 'kikename' }),
      encodeDelegate(config, { name: 'kikename', host: 'x.com' }),
      encodeAuction(config, { name: 'kikename', reserve: FLOOR, endHeight: 1, minPrice: FLOOR }),
      encodeGovernance(config, { feeStandard: 1n, feeLong: 1n, commissionBp: 0n, effectiveHeight: 1 }),
      encodeUnreserve(config, { name: 'kikename', effectiveHeight: 1 }),
    ]) {
      expect(tx.recipient).toBe(PROTOCOL)
      expect(tx.value).toBe(CONSTANTS.DUST_VALUE)
    }
  })

  it('puts the counterparty in the recipient for S, X and R', () => {
    expect(encodeSetTarget(config, { name: 'kikename', target: BOB }).recipient).toBe(BOB)
    expect(encodeTransfer(config, { name: 'kikename', newOwner: BOB }).recipient).toBe(BOB)
    expect(encodeRecovery(config, { name: 'kikename', recovery: BOB }).recipient).toBe(BOB)
  })

  it('uses the protocol address as the §5.3 sentinel for the two unsendable operations', () => {
    // Resetting a target to the owner's own address, and clearing a recovery
    // address, are both self-transactions — which Nimiq drops silently.
    expect(encodeSetTarget(config, { name: 'kikename', target: null }).recipient).toBe(PROTOCOL)
    expect(encodeRecovery(config, { name: 'kikename', recovery: null }).recipient).toBe(PROTOCOL)
  })

  it('sends B to the marketplace carrying the price exactly', () => {
    const tx = encodeBuy(config, { name: 'kikename', price: 999n })
    expect(tx.recipient).toBe(MARKETPLACE)
    expect(tx.value).toBe(999n)
  })

  it('sends F to the canonical burn address carrying the amount burned', () => {
    const tx = encodeBurn(config, { amount: 12_345n })
    expect(tx.recipient).toBe(BURN_ADDRESS)
    expect(tx.value).toBe(12_345n)
    expect(tx.data).toBe(hex('NNS1F'))
  })

  it('falls back to DUST_VALUE when the OPEN listing fee is zero', () => {
    expect(config.listingFee).toBe(0n)
    expect(encodeOffer(config, { name: 'kikename', price: FLOOR, minPrice: FLOOR }).value).toBe(CONSTANTS.DUST_VALUE)
    expect(
      encodeOffer(testConfig({ listingFee: 500n }), { name: 'kikename', price: FLOOR, minPrice: FLOOR }).value,
    ).toBe(500n)
  })
})

describe('builders fail loudly where the chain would fail silently', () => {
  it('rejects an over-length message with the limit that applies to it', () => {
    // Every fixed-shape message is bounded by its own field limits, so the
    // only way to overrun is a D combining a maximal name with a maximal host.
    expect(() => encodeDelegate(config, { name: 'a'.repeat(24), host: 'b'.repeat(30) })).toThrow(
      /over the 58-byte limit/,
    )
  })

  it('mentions the silent-drop consequence, because that is the whole point', () => {
    expect(() => encodeDelegate(config, { name: 'a'.repeat(24), host: 'b'.repeat(30) })).toThrow(
      /network would silently drop it/,
    )
  })

  it('holds D to MAX_DELEGATE_MESSAGE_BYTES, not the global ceiling', () => {
    // 5 + name + 1 + host must be <= 58, so name + host <= 52.
    const name = 'a'.repeat(24)
    expect(() => encodeDelegate(config, { name, host: 'b'.repeat(28) })).not.toThrow()
    expect(() => encodeDelegate(config, { name, host: 'b'.repeat(29) })).toThrow(CodecError)
  })

  it('refuses a self-transaction when the sender is supplied (§5.3)', () => {
    expect(() => encodeTransfer(config, { name: 'kikename', newOwner: ALICE, sender: ALICE })).toThrow(
      /sender and recipient must differ/,
    )
    expect(() => encodeCancel(config, { name: 'kikename', sender: PROTOCOL })).toThrow(CodecError)
  })

  it('refuses a value of 0, which the network rejects (§5.4)', () => {
    expect(() => encodeRegister(config, { name: 'kikename', fee: 0n })).toThrow(/value must be positive/)
  })

  it('rejects an invalid or reserved name for G, both checkable offline (§7.4)', () => {
    expect(() => encodeRegister(config, { name: 'n1m1q', fee: 1n })).toThrow(/INTERIOR_DIGIT/)
    expect(() => encodeRegister(config, { name: 'abcd', fee: 1n })).toThrow(/TOO_SHORT/)
    const withReserved = testConfig({ reservedNames: ['binance'] })
    expect(() => encodeRegister(withReserved, { name: 'binance', fee: 1n })).toThrow(/RESERVED/)
  })

  it('does not apply the reserved list to U, which names a reserved name by definition', () => {
    const withReserved = testConfig({ reservedNames: ['binance'] })
    expect(() => encodeUnreserve(withReserved, { name: 'binance', effectiveHeight: 1 })).not.toThrow()
  })

  it('routes a U by its operand: release to the protocol address, award to the awardee (§6 U)', () => {
    // The payload is identical in both cases — the recipient decides.
    const release = encodeUnreserve(config, { name: 'binance', effectiveHeight: 1, recipient: null })
    const award = encodeUnreserve(config, { name: 'binance', effectiveHeight: 1, recipient: BOB })
    expect(release.recipient).toBe(PROTOCOL)
    expect(award.recipient).toBe(BOB)
    expect(award.data).toBe(release.data)
  })

  it('refuses to award to BURN_ADDRESS — the reducer would forfeit INVALID_RECIPIENT', () => {
    expect(() => encodeUnreserve(config, { name: 'binance', effectiveHeight: 1, recipient: BURN_ADDRESS })).toThrow(
      /BURN_ADDRESS/,
    )
  })

  it('rejects a delegate host that carries a scheme (§6 D)', () => {
    expect(() => encodeDelegate(config, { name: 'binance', host: 'https://nns.binance.com' })).toThrow(
      /BAD_CHARACTER/,
    )
  })

  it('rejects a malformed ref rather than silently dropping it', () => {
    // parse() records a bad ref as absent; a *builder* has a client in front
    // of it, so it says so instead.
    expect(() => encodeRegister(config, { name: 'kikename', ref: 'Coinbase', fee: 1n })).toThrow(/invalid ref/)
    expect(() => encodeRegister(config, { name: 'kikename', ref: 'a'.repeat(13), fee: 1n })).toThrow(/invalid ref/)
  })

  it('rejects an O price or an A reserve below MIN_PRICE (§6 O, §6 A)', () => {
    expect(() => encodeOffer(config, { name: 'kikename', price: FLOOR - 1n, minPrice: FLOOR })).toThrow(
      /below MIN_PRICE/,
    )
    expect(() => encodeOffer(config, { name: 'kikename', price: 0n, minPrice: FLOOR })).toThrow(/below MIN_PRICE/)
    expect(() =>
      encodeAuction(config, { name: 'kikename', reserve: FLOOR - 1n, endHeight: 58_200_000, minPrice: FLOOR }),
    ).toThrow(/below MIN_PRICE/)
    // Exactly at the floor is fine — the boundary is inclusive.
    expect(encodeOffer(config, { name: 'kikename', price: FLOOR, minPrice: FLOOR }).data).toBe(
      hex(`NNS1Okikename|${FLOOR}`),
    )
  })

  it('takes the floor as a parameter, so a governed MIN_PRICE cannot go stale', () => {
    // FEE_LONG doubled by a `P`: what the builder accepted yesterday it must
    // refuse today. A builder reading CONSTANTS.FEE_LONG could not do this.
    const moved = FLOOR * 2n
    expect(encodeOffer(config, { name: 'kikename', price: FLOOR, minPrice: FLOOR }).data).toBeTruthy()
    expect(() => encodeOffer(config, { name: 'kikename', price: FLOOR, minPrice: moved })).toThrow(/below MIN_PRICE/)
  })

  it('rejects a negative amount or an unsafe height', () => {
    const negative = { feeStandard: -1n, feeLong: 1n, commissionBp: 0n, effectiveHeight: 1 }
    expect(() => encodeGovernance(config, negative)).toThrow(/must not be negative/)
    expect(() => encodeUnreserve(config, { name: 'kikename', effectiveHeight: 1.5 })).toThrow(CodecError)
  })
})

describe('parse tolerance — §5.2, §7.5', () => {
  it('reports NOT_NNS1 for ordinary chain traffic', () => {
    expect(parse(hex('hello world'))).toEqual({ ok: false, reason: 'NOT_NNS1' })
    expect(parse('')).toEqual({ ok: false, reason: 'NOT_NNS1' })
  })

  it('reports UNKNOWN_TYPE for a type character not in the table', () => {
    expect(parse(hex('NNS1Zkikename'))).toEqual({ ok: false, reason: 'UNKNOWN_TYPE' })
    expect(parse(hex('NNS1gkikename'))).toEqual({ ok: false, reason: 'UNKNOWN_TYPE' })
  })

  it('reports OVER_LENGTH past the budget', () => {
    expect(parse(hex(`NNS1G${'a'.repeat(60)}`))).toEqual({ ok: false, reason: 'OVER_LENGTH' })
  })

  it('reports NOT_HEX for anything that is not hex', () => {
    expect(parse('zz')).toEqual({ ok: false, reason: 'NOT_HEX' })
    expect(parse('4e4e5331470')).toEqual({ ok: false, reason: 'NOT_HEX' })
  })

  it('does not judge names — an invalid name parses, for the reducer to reject', () => {
    // §7.6: a rejected message still earns a log line, so it must parse first.
    expect(parsed('NNS1Gn1m1q')).toEqual({ type: 'G', name: 'n1m1q', ref: null })
    expect(parsed('NNS1GNIMIQ')).toEqual({ type: 'G', name: 'NIMIQ', ref: null })
  })

  it('records an unknown or malformed ref as absent, and registers anyway (§6 G)', () => {
    // "Accounting must never be able to reject a paid registration."
    expect(parsed('NNS1Gkikename|Coinbase')).toEqual({ type: 'G', name: 'kikename', ref: null })
    expect(parsed('NNS1Gkikename|')).toEqual({ type: 'G', name: 'kikename', ref: null })
    expect(parsed(`NNS1Gkikename|${'a'.repeat(13)}`)).toEqual({ type: 'G', name: 'kikename', ref: null })
    expect(parsed('NNS1Gkikename|a|b')).toEqual({ type: 'G', name: 'kikename', ref: null })
  })

  it('reports MALFORMED_PAYLOAD on the wrong field count', () => {
    for (const text of ['NNS1Dbinance', 'NNS1Okikename', 'NNS1M58060800', 'NNS1P1|2|3', 'NNS1Ubinance', 'NNS1Fx']) {
      expect(parse(hex(text))).toEqual({ ok: false, reason: 'MALFORMED_PAYLOAD' })
    }
  })

  it('reports MALFORMED_PAYLOAD on an empty name', () => {
    expect(parse(hex('NNS1G'))).toEqual({ ok: false, reason: 'MALFORMED_PAYLOAD' })
    expect(parse(hex('NNS1S'))).toEqual({ ok: false, reason: 'MALFORMED_PAYLOAD' })
    expect(parse(hex('NNS1D|host.com'))).toEqual({ ok: false, reason: 'MALFORMED_PAYLOAD' })
  })

  it('requires canonical decimal — one representation per value', () => {
    for (const text of ['NNS1Okikename|0123', 'NNS1Okikename|-5', 'NNS1Okikename| 5', 'NNS1M0058060800|0']) {
      expect(parse(hex(text))).toEqual({ ok: false, reason: 'MALFORMED_PAYLOAD' })
    }
    expect(parsed('NNS1Okikename|0')).toEqual({ type: 'O', name: 'kikename', price: 0n })
  })

  it('keeps tx_index zero-based, exactly as written (§8.2)', () => {
    expect(parsed('NNS1M58060800|0')).toEqual({ type: 'M', height: 58_060_800, txIndex: 0 })
  })

  it('parses a D that clears the delegation', () => {
    expect(parsed('NNS1Dbinance|')).toEqual({ type: 'D', name: 'binance', host: '' })
  })

  it('accepts a price that overflows a double, because amounts are bigint', () => {
    const huge = 9_007_199_254_740_993n // 2^53 + 1
    expect(parsed(`NNS1Okikename|${huge}`)).toEqual({ type: 'O', name: 'kikename', price: huge })
  })
})

describe('§6 stated message sizes', () => {
  const bytes = (data: string): number => data.length / 2

  it('G at maximum is 42 bytes', () => {
    const tx = encodeRegister(config, { name: 'a'.repeat(24), ref: 'b'.repeat(12), fee: 1n })
    expect(bytes(tx.data)).toBe(42)
  })

  it('D at maximum is 58 bytes', () => {
    const tx = encodeDelegate(config, { name: 'a'.repeat(24), host: 'b'.repeat(28) })
    expect(bytes(tx.data)).toBe(58)
  })

  it('F is 5 bytes', () => {
    expect(bytes(encodeBurn(config, { amount: 1n }).data)).toBe(5)
  })

  it('the example from §6 D is 28 bytes', () => {
    const tx = encodeDelegate(config, { name: 'binance', host: 'nns.binance.com' })
    expect(bytes(tx.data)).toBe(28)
  })
})
