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
  encodeRegister,
  encodeRenew,
  encodeSetEvm,
  encodeSetTarget,
  encodeSettlement,
  encodeTransfer,
  encodeUnreserve,
  parse,
  type Message,
} from './codec.js'
import { CONSTANTS, LUNA_PER_NIM } from './constants.js'
import { LAUNCH_PRICES, minPrice } from './state.js'
import { ALICE, BOB, MARKETPLACE, PROTOCOL, TREASURY, testConfig } from './test-fixtures.js'

const config = testConfig()
/** §3 `MIN_PRICE` at launch prices — the floor on an `O` price and an `A` starting price. */
const FLOOR = minPrice(LAUNCH_PRICES)

/** ASCII → lowercase hex, written independently of the implementation. */
const hex = (text: string): string =>
  [...text].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')

const parsed = (text: string): Message | null => {
  const result = parse(hex(text))
  return result.ok ? result.message : null
}

describe('the mainnet-verified known answer', () => {
  it('encodes NNS1Gtestname to 4e4e533147746573746e616d65 (§5.1)', () => {
    const tx = encodeRegister({ name: 'testname', fee: 2_000n * LUNA_PER_NIM })
    expect(tx.data).toBe('4e4e533147746573746e616d65')
  })

  it('reads it back', () => {
    expect(parse('4e4e533147746573746e616d65')).toEqual({
      ok: true,
      message: { type: 'G', name: 'testname', ref: null, lifetime: false },
    })
  })
})

describe('every message type round-trips encode → parse', () => {
  const cases: ReadonlyArray<readonly [string, { data: string }, Message]> = [
    ['G', encodeRegister({ name: 'kikename', fee: 1n }), { type: 'G', name: 'kikename', ref: null, lifetime: false }],
    [
      'G with ref',
      encodeRegister({ name: 'kikename', ref: 'coinbase', fee: 1n }),
      { type: 'G', name: 'kikename', ref: 'coinbase', lifetime: false },
    ],
    [
      'G lifetime with ref',
      encodeRegister({ name: 'kikename', ref: 'coinbase', fee: 1n, lifetime: true }),
      { type: 'G', name: 'kikename', ref: 'coinbase', lifetime: true },
    ],
    [
      'G lifetime without ref',
      encodeRegister({ name: 'kikename', fee: 1n, lifetime: true }),
      { type: 'G', name: 'kikename', ref: null, lifetime: true },
    ],
    ['S', encodeSetTarget({ name: 'kikename', target: BOB }), { type: 'S', name: 'kikename' }],
    ['S reset', encodeSetTarget({ name: 'kikename', target: null }), { type: 'S', name: 'kikename' }],
    [
      'E',
      encodeSetEvm({ name: 'kikename', evm: '0x1B3F6a09E2c40D55c8a1b2C3d4E5F60718293A4b' }),
      { type: 'E', name: 'kikename', evm: '0x1b3f6a09e2c40d55c8a1b2c3d4e5f60718293a4b' },
    ],
    ['E clear', encodeSetEvm({ name: 'kikename', evm: null }), { type: 'E', name: 'kikename', evm: '' }],
    ['X', encodeTransfer({ name: 'kikename', newOwner: BOB }), { type: 'X', name: 'kikename' }],
    [
      'D',
      encodeDelegate({ name: 'binance', host: 'nns.binance.com' }),
      { type: 'D', name: 'binance', host: 'nns.binance.com' },
    ],
    ['D clear', encodeDelegate({ name: 'binance', host: '' }), { type: 'D', name: 'binance', host: '' }],
    ['K', encodeCancel({ name: 'kikename' }), { type: 'K', name: 'kikename' }],
    ['N', encodeRenew({ name: 'kikename', fee: 1n }), { type: 'N', name: 'kikename', lifetime: false }],
    ['N lifetime', encodeRenew({ name: 'kikename', fee: 1n, lifetime: true }), { type: 'N', name: 'kikename', lifetime: true }],
    [
      'O',
      encodeOffer({ name: 'kikename', price: 123_456_789n, minPrice: FLOOR }),
      { type: 'O', name: 'kikename', price: 123_456_789n },
    ],
    ['B', encodeBuy({ name: 'kikename', price: 5n }), { type: 'B', name: 'kikename' }],
    [
      'M',
      encodeSettlement({ height: 58_060_800, txIndex: 0, payee: BOB, amount: 7n }),
      { type: 'M', height: 58_060_800, txIndex: 0 },
    ],
    [
      'A',
      encodeAuction({ name: 'kikename', startingPrice: 62_500_000n, endHeight: 58_200_000, minPrice: FLOOR }),
      { type: 'A', name: 'kikename', startingPrice: 62_500_000n, endHeight: 58_200_000 },
    ],
    [
      'P',
      encodeGovernance({ feeBase: CONSTANTS.FEE_BASE, commissionBp: 250n, effectiveHeight: 58_100_000 }),
      { type: 'P', feeBase: CONSTANTS.FEE_BASE, commissionBp: 250n, effectiveHeight: 58_100_000 },
    ],
    ['U', encodeUnreserve({ name: 'binance' }), { type: 'U', name: 'binance', lifetime: false }],
    [
      'U lifetime award',
      encodeUnreserve({ name: 'nq', recipient: BOB, lifetime: true }),
      { type: 'U', name: 'nq', lifetime: true },
    ],
    ['F', encodeBurn({ amount: 1_000n }), { type: 'F' }],
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
    expect(encodeRegister({ name: 'kikename', fee: 400n }).recipient).toBe(TREASURY)
    expect(encodeRenew({ name: 'kikename', fee: 400n }).recipient).toBe(TREASURY)
    expect(encodeOffer({ name: 'kikename', price: FLOOR, minPrice: FLOOR }).recipient).toBe(TREASURY)
  })

  it('sends dust-only signalling to the protocol address', () => {
    for (const tx of [
      encodeCancel({ name: 'kikename' }),
      encodeDelegate({ name: 'kikename', host: 'x.com' }),
      encodeAuction({ name: 'kikename', startingPrice: FLOOR, endHeight: 1, minPrice: FLOOR }),
      encodeGovernance({ feeBase: 1n, commissionBp: 0n, effectiveHeight: 1 }),
      encodeUnreserve({ name: 'kikename' }),
    ]) {
      expect(tx.recipient).toBe(PROTOCOL)
      expect(tx.value).toBe(CONSTANTS.DUST_VALUE)
    }
  })

  it('puts the counterparty in the recipient for S and X', () => {
    expect(encodeSetTarget({ name: 'kikename', target: BOB }).recipient).toBe(BOB)
    expect(encodeTransfer({ name: 'kikename', newOwner: BOB }).recipient).toBe(BOB)
  })

  it('uses the protocol address as the §5.3 sentinel for the one unsendable operation', () => {
    // Resetting a target to the owner's own address is a self-transaction,
    // which Nimiq drops silently. Clearing a recovery address was the second
    // such operation until r20 removed `R`.
    expect(encodeSetTarget({ name: 'kikename', target: null }).recipient).toBe(PROTOCOL)
  })

  it('parses NNS1R as an unknown type — `R` is removed, not reserved (r20)', () => {
    // The letter is not held open for a future revision: an `R` built by a
    // pre-r20 client forfeits UNKNOWN_TYPE rather than being silently ignored.
    const data = Buffer.from('NNS1Rkikename', 'ascii').toString('hex')
    expect(parse(data)).toEqual({ ok: false, reason: 'UNKNOWN_TYPE' })
  })

  it('sends B to the marketplace carrying the price exactly', () => {
    const tx = encodeBuy({ name: 'kikename', price: 999n })
    expect(tx.recipient).toBe(MARKETPLACE)
    expect(tx.value).toBe(999n)
  })

  it('sends F to the canonical burn address carrying the amount burned', () => {
    const tx = encodeBurn({ amount: 12_345n })
    expect(tx.recipient).toBe(BURN_ADDRESS)
    expect(tx.value).toBe(12_345n)
    expect(tx.data).toBe(hex('NNS1F'))
  })

  it('carries DUST_VALUE, because LISTING_FEE is frozen at zero and §5.4 rejects a value of 0', () => {
    expect(CONSTANTS.LISTING_FEE).toBe(0n)
    expect(encodeOffer({ name: 'kikename', price: FLOOR, minPrice: FLOOR }).value).toBe(CONSTANTS.DUST_VALUE)
  })
})

describe('builders fail loudly where the chain would fail silently', () => {
  it('rejects an over-length message with the limit that applies to it', () => {
    // Every fixed-shape message is bounded by its own field limits, so the
    // only way to overrun is a D combining a maximal name with a maximal host.
    expect(() => encodeDelegate({ name: 'a'.repeat(24), host: 'b'.repeat(30) })).toThrow(
      /over the 58-byte limit/,
    )
  })

  it('mentions the silent-drop consequence, because that is the whole point', () => {
    expect(() => encodeDelegate({ name: 'a'.repeat(24), host: 'b'.repeat(30) })).toThrow(
      /network would silently drop it/,
    )
  })

  it('holds D to MAX_DELEGATE_MESSAGE_BYTES, not the global ceiling', () => {
    // 5 + name + 1 + host must be <= 58, so name + host <= 52.
    const name = 'a'.repeat(24)
    expect(() => encodeDelegate({ name, host: 'b'.repeat(28) })).not.toThrow()
    expect(() => encodeDelegate({ name, host: 'b'.repeat(29) })).toThrow(CodecError)
  })

  it('refuses a self-transaction when the sender is supplied (§5.3)', () => {
    expect(() => encodeTransfer({ name: 'kikename', newOwner: ALICE, sender: ALICE })).toThrow(
      /sender and recipient must differ/,
    )
    expect(() => encodeCancel({ name: 'kikename', sender: PROTOCOL })).toThrow(CodecError)
  })

  it('refuses a value of 0, which the network rejects (§5.4)', () => {
    expect(() => encodeRegister({ name: 'kikename', fee: 0n })).toThrow(/value must be positive/)
  })

  it('rejects an invalid name for G, which is checkable offline (§7.4)', () => {
    expect(() => encodeRegister({ name: 'n1m1q', fee: 1n })).toThrow(/INTERIOR_DIGIT/)
    // A short name failing rules 2–5 is on neither §4.1 membership route and
    // can never be released, so the builder refuses it outright.
    expect(() => encodeRegister({ name: 'ab-', fee: 1n })).toThrow(/TOO_SHORT/)
  })

  it('does not reject a G on reservation alone — released-ness is chain state the builder cannot see', () => {
    expect(() => encodeRegister({ name: 'binance', fee: 1n })).not.toThrow()
    // Well-formed short names are reserved by rule (§4.1) — the same case:
    // a released `abcd` is a normal name and its G must be encodable.
    expect(() => encodeRegister({ name: 'abcd', fee: 1n })).not.toThrow()
  })

  it('does not apply the reserved list to U, which names a reserved name by definition', () => {
    expect(() => encodeUnreserve({ name: 'binance' })).not.toThrow()
  })

  it('routes a U by its operand: release to the protocol address, award to the awardee (§6 U)', () => {
    // The payload is identical in both cases — the recipient decides.
    const release = encodeUnreserve({ name: 'binance', recipient: null })
    const award = encodeUnreserve({ name: 'binance', recipient: BOB })
    expect(release.recipient).toBe(PROTOCOL)
    expect(award.recipient).toBe(BOB)
    expect(award.data).toBe(release.data)
  })

  it('refuses to award to BURN_ADDRESS — the reducer would forfeit INVALID_RECIPIENT', () => {
    expect(() => encodeUnreserve({ name: 'binance', recipient: BURN_ADDRESS })).toThrow(
      /BURN_ADDRESS/,
    )
  })

  it('rejects a delegate host that carries a scheme (§6 D)', () => {
    expect(() => encodeDelegate({ name: 'binance', host: 'https://nns.binance.com' })).toThrow(
      /BAD_CHARACTER/,
    )
  })

  it('rejects a malformed ref rather than silently dropping it', () => {
    // parse() records a bad ref as absent; a *builder* has a client in front
    // of it, so it says so instead.
    expect(() => encodeRegister({ name: 'kikename', ref: 'Coinbase', fee: 1n })).toThrow(/invalid ref/)
    expect(() => encodeRegister({ name: 'kikename', ref: 'a'.repeat(25), fee: 1n })).toThrow(/invalid ref/)
  })

  it('rejects an O price or an A starting price below MIN_PRICE (§6 O, §6 A)', () => {
    expect(() => encodeOffer({ name: 'kikename', price: FLOOR - 1n, minPrice: FLOOR })).toThrow(
      /below MIN_PRICE/,
    )
    expect(() => encodeOffer({ name: 'kikename', price: 0n, minPrice: FLOOR })).toThrow(/below MIN_PRICE/)
    expect(() =>
      encodeAuction({ name: 'kikename', startingPrice: FLOOR - 1n, endHeight: 58_200_000, minPrice: FLOOR }),
    ).toThrow(/below MIN_PRICE/)
    // Exactly at the floor is fine — the boundary is inclusive.
    expect(encodeOffer({ name: 'kikename', price: FLOOR, minPrice: FLOOR }).data).toBe(
      hex(`NNS1Okikename|${FLOOR}`),
    )
  })

  it('takes the floor as a parameter, so a governed MIN_PRICE cannot go stale', () => {
    // FEE_BASE doubled by a `P`: what the builder accepted yesterday it must
    // refuse today. A builder reading CONSTANTS.FEE_BASE could not do this.
    const moved = FLOOR * 2n
    expect(encodeOffer({ name: 'kikename', price: FLOOR, minPrice: FLOOR }).data).toBeTruthy()
    expect(() => encodeOffer({ name: 'kikename', price: FLOOR, minPrice: moved })).toThrow(/below MIN_PRICE/)
  })

  it('rejects a negative amount or an unsafe height', () => {
    const negative = { feeBase: -1n, commissionBp: 0n, effectiveHeight: 1 }
    expect(() => encodeGovernance(negative)).toThrow(/must not be negative/)
    expect(() => encodeGovernance({ ...negative, feeBase: 1n, effectiveHeight: 1.5 })).toThrow(CodecError)
  })
})

describe('the lifetime field — §6 G, N, U and §10.4', () => {
  const text = (built: { data: string }): string =>
    (built.data.match(/../g) ?? []).map((byte) => String.fromCharCode(Number.parseInt(byte, 16))).join('')

  it('is a trailing L, and an empty ref carries it without a referrer', () => {
    expect(text(encodeRegister({ name: 'kikename', fee: 1n, lifetime: true }))).toBe('NNS1Gkikename||L')
    expect(text(encodeRegister({ name: 'kikename', ref: 'coinbase', fee: 1n, lifetime: true }))).toBe(
      'NNS1Gkikename|coinbase|L',
    )
    expect(text(encodeRenew({ name: 'kikename', fee: 1n, lifetime: true }))).toBe('NNS1Nkikename|L')
    expect(text(encodeUnreserve({ name: 'nq', recipient: BOB, lifetime: true }))).toBe('NNS1Unq|L')
    // `lifetime: false` is the same message as no flag at all.
    expect(encodeRegister({ name: 'kikename', fee: 1n, lifetime: false })).toEqual(
      encodeRegister({ name: 'kikename', fee: 1n }),
    )
  })

  it('fits the largest G in 56 bytes (§6 G)', () => {
    const built = encodeRegister({ name: 'a'.repeat(24), ref: 'b'.repeat(24), fee: 1n, lifetime: true })
    expect(built.data.length / 2).toBe(56)
  })

  it('refuses a lifetime on a release — the reducer would ignore it, and the sender did not mean it', () => {
    expect(() => encodeUnreserve({ name: 'binance', lifetime: true })).toThrow(/release has no term/)
    expect(() => encodeUnreserve({ name: 'binance', recipient: null, lifetime: true })).toThrow(CodecError)
  })

  it.each([
    ['G third field other than L', 'NNS1Gkikename|coinbase|l'],
    ['G empty third field', 'NNS1Gkikename|coinbase|'],
    ['G empty third field, empty ref', 'NNS1Gkikename||'],
    ['G four fields', 'NNS1Gkikename|coinbase|L|'],
    ['N second field other than L', 'NNS1Nkikename|LL'],
    ['N empty second field', 'NNS1Nkikename|'],
    ['N three fields', 'NNS1Nkikename|L|L'],
    ['U second field other than L', 'NNS1Ubinance|x'],
    ['U r21 height form', 'NNS1Ubinance|58942720'],
    ['U empty second field', 'NNS1Ubinance|'],
  ])('rejects %s as MALFORMED_PAYLOAD', (_label, payload) => {
    expect(parse(hex(payload))).toEqual({ ok: false, reason: 'MALFORMED_PAYLOAD' })
  })

  it('reads L in the third G field whatever the ref, and only there', () => {
    expect(parsed('NNS1Gkikename||L')).toEqual({ type: 'G', name: 'kikename', ref: null, lifetime: true })
    expect(parsed('NNS1Gkikename|Coinbase|L')).toEqual({ type: 'G', name: 'kikename', ref: null, lifetime: true })
    // `L` is a valid ref on its own — a one-letter registered name — so in
    // the second field it is a referrer, not a term.
    expect(parsed('NNS1Gkikename|l')).toEqual({ type: 'G', name: 'kikename', ref: 'l', lifetime: false })
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
    expect(parsed('NNS1Gn1m1q')).toEqual({ type: 'G', name: 'n1m1q', ref: null, lifetime: false })
    expect(parsed('NNS1GNIMIQ')).toEqual({ type: 'G', name: 'NIMIQ', ref: null, lifetime: false })
  })

  it('records an unknown or malformed ref as absent, and registers anyway (§6 G)', () => {
    // "Accounting must never be able to reject a paid registration."
    const absent = { type: 'G', name: 'kikename', ref: null, lifetime: false }
    expect(parsed('NNS1Gkikename|Coinbase')).toEqual(absent)
    expect(parsed('NNS1Gkikename|')).toEqual(absent)
    expect(parsed(`NNS1Gkikename|${'a'.repeat(25)}`)).toEqual(absent)
    // A pipe inside the ref is a third field since 2026-09-11, and that field
    // is a shape (`L` or nothing), not accounting — see the lifetime block.
    expect(parse(hex('NNS1Gkikename|a|b'))).toEqual({ ok: false, reason: 'MALFORMED_PAYLOAD' })
  })

  it('reports MALFORMED_PAYLOAD on the wrong field count', () => {
    // `NNS1P1|2|3|4` is the two-price form a `P` carried through 2026-09-10.
    for (const text of ['NNS1Dbinance', 'NNS1Okikename', 'NNS1M58060800', 'NNS1P1|2', 'NNS1P1|2|3|4', 'NNS1Fx']) {
      expect(parse(hex(text))).toEqual({ ok: false, reason: 'MALFORMED_PAYLOAD' })
    }
  })

  it('rejects an r21-format U, which carried an effective height (r22)', () => {
    // A `U` is one field since r22: it executes in the block it lands in, so
    // there is no height to carry. An old client's message must fail loudly
    // rather than release a name on a number nothing reads.
    expect(parse(hex('NNS1Ubinance|58900000'))).toEqual({ ok: false, reason: 'MALFORMED_PAYLOAD' })
    expect(parse(hex('NNS1Ubinance|'))).toEqual({ ok: false, reason: 'MALFORMED_PAYLOAD' })
    expect(parsed('NNS1Ubinance')).toEqual({ type: 'U', name: 'binance', lifetime: false })
  })

  it('reports MALFORMED_PAYLOAD on an empty name', () => {
    expect(parse(hex('NNS1G'))).toEqual({ ok: false, reason: 'MALFORMED_PAYLOAD' })
    expect(parse(hex('NNS1S'))).toEqual({ ok: false, reason: 'MALFORMED_PAYLOAD' })
    expect(parse(hex('NNS1D|host.com'))).toEqual({ ok: false, reason: 'MALFORMED_PAYLOAD' })
    expect(parse(hex('NNS1U'))).toEqual({ ok: false, reason: 'MALFORMED_PAYLOAD' })
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

  it('G at maximum is 54 bytes', () => {
    const tx = encodeRegister({ name: 'a'.repeat(24), ref: 'b'.repeat(24), fee: 1n })
    expect(bytes(tx.data)).toBe(54)
  })

  it('D at maximum is 58 bytes', () => {
    const tx = encodeDelegate({ name: 'a'.repeat(24), host: 'b'.repeat(28) })
    expect(bytes(tx.data)).toBe(58)
  })

  it('F is 5 bytes', () => {
    expect(bytes(encodeBurn({ amount: 1n }).data)).toBe(5)
  })

  it('the example from §6 D is 28 bytes', () => {
    const tx = encodeDelegate({ name: 'binance', host: 'nns.binance.com' })
    expect(bytes(tx.data)).toBe(28)
  })
})
