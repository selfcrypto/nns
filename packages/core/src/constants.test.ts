import { describe, expect, it } from 'vitest'
import { parseAddress } from './address.js'
import { CONSTANTS, LUNA_PER_NIM } from './constants.js'
import { validateNameSyntax } from './name.js'

describe('CONSTANTS — §3', () => {
  it('is frozen, so nothing downstream can edit a protocol rule at runtime', () => {
    expect(Object.isFrozen(CONSTANTS)).toBe(true)
  })

  it('states every amount in luna, matching the NIM figures §3 prints', () => {
    expect(LUNA_PER_NIM).toBe(100_000n)
    expect(CONSTANTS.FEE_STANDARD).toBe(400_000_000n) // 4,000 NIM
    expect(CONSTANTS.FEE_LONG).toBe(40_000_000n) //       400 NIM
    expect(CONSTANTS.PRICE_FLOOR).toBe(100_000n) //         1 NIM
    expect(CONSTANTS.PRICE_CEILING).toBe(10_000_000_000n) // 100,000 NIM
  })

  it('keeps the launch prices inside the governance bounds they are subject to', () => {
    for (const fee of [CONSTANTS.FEE_STANDARD, CONSTANTS.FEE_LONG]) {
      expect(fee).toBeGreaterThanOrEqual(CONSTANTS.PRICE_FLOOR)
      expect(fee).toBeLessThanOrEqual(CONSTANTS.PRICE_CEILING)
    }
    // §10.6: fee_long MUST be <= fee_standard.
    expect(CONSTANTS.FEE_LONG).toBeLessThanOrEqual(CONSTANTS.FEE_STANDARD)
    expect(CONSTANTS.COMMISSION_RATE).toBeLessThanOrEqual(CONSTANTS.COMMISSION_CEILING)
  })

  it('cannot use a DUST_VALUE of 0 — the network rejects it (§5.4)', () => {
    expect(CONSTANTS.DUST_VALUE).toBeGreaterThan(0n)
  })

  it('caps D below the global data ceiling, so it keeps the same margin (§6 D)', () => {
    expect(CONSTANTS.MAX_DELEGATE_MESSAGE_BYTES).toBeLessThan(CONSTANTS.MAX_DATA_BYTES)
  })

  it('leaves every message type room inside the 64-byte budget (§5.1, §6)', () => {
    const prefix = CONSTANTS.PROTOCOL_ID.length + 1 // NNS1 + type character
    // The sizes §6 states for its largest messages, recomputed from constants.
    expect(prefix + CONSTANTS.MAX_NAME_LEN + 1 + CONSTANTS.MAX_REF_LEN).toBe(42) // G
    expect(prefix + CONSTANTS.MAX_NAME_LEN + 1 + 15).toBe(45) // O
    expect(prefix + CONSTANTS.MAX_NAME_LEN + 1 + 15 + 1 + 10).toBe(56) // A
    for (const size of [42, 45, 56, CONSTANTS.MAX_DELEGATE_MESSAGE_BYTES]) {
      expect(size).toBeLessThanOrEqual(CONSTANTS.MAX_DATA_BYTES)
    }
  })

  it('orders the name-length thresholds as §4.1 and §10.1 require', () => {
    expect(CONSTANTS.MIN_NAME_LEN).toBeLessThan(CONSTANTS.LONG_NAME_LEN)
    expect(CONSTANTS.LONG_NAME_LEN).toBeLessThan(CONSTANTS.MAX_NAME_LEN)
  })

  it('has no recovery timelock — `R` was removed in r20', () => {
    expect(CONSTANTS).not.toHaveProperty('RECOVERY_TIMELOCK')
  })

  it('lets an offer be cancelled well before it auto-expires (§6 O)', () => {
    expect(CONSTANTS.OFFER_IRREVOCABLE).toBeLessThan(CONSTANTS.OFFER_MAX_LIFETIME)
  })

  it('equals the mainnet values, field for field', () => {
    // Every value restated as an inline literal — never derived from
    // constants.ts, or an edit there would move both sides. Compressed-tempo
    // testing edits CONSTANTS on a throwaway branch that is never merged
    // ("Constants profiles" in docs/decisions.md); this is the test that
    // fails CI if such an edit ever reaches master. It also covers
    // CHECKPOINT_INTERVAL, which no conformance vector exercises.
    // RESERVED_NAMES is pinned separately, as a set: it is the one entry whose
    // *order* must not be protocol (see below).
    const { RESERVED_NAMES: _reserved, ...values } = CONSTANTS
    expect(values).toStrictEqual({
      PROTOCOL_ID: 'NNS1',
      MAX_DATA_BYTES: 64,
      MAX_DELEGATE_MESSAGE_BYTES: 58,
      MIN_NAME_LEN: 5,
      LONG_NAME_LEN: 12,
      MAX_NAME_LEN: 24,
      MAX_LABEL_LEN: 24,
      MAX_HOST_LEN: 30,
      MAX_REF_LEN: 12,
      DUST_VALUE: 1n,
      REFUND_FLOOR: 10_000n,
      LISTING_FEE: 0n,
      FEE_STANDARD: 400_000_000n, //         4,000 NIM
      FEE_LONG: 40_000_000n, //                400 NIM
      PRICE_FLOOR: 100_000n, //                  1 NIM
      PRICE_CEILING: 10_000_000_000n, //   100,000 NIM
      PRICE_MAX_FACTOR: 2n,
      PRICE_MIN_INTERVAL: 604_800,
      COMMISSION_RATE: 250n,
      COMMISSION_CEILING: 1_000n,
      COMMISSION_MAX_STEP: 250n,
      BURN_SHARE_BP: 2_000n,
      BASIS_POINTS: 10_000n,
      GOVERNANCE_DELAY: 43_200,
      XFER_TIMELOCK: 43_200,
      TERM_LENGTH: 157_680_000,
      GRACE_PERIOD: 7_776_000,
      OFFER_IRREVOCABLE: 8_640,
      OFFER_MAX_LIFETIME: 1_296_000,
      AUCTION_MIN_INCREMENT_BP: 500n,
      AUCTION_MIN_DURATION: 86_400,
      AUCTION_EXTENSION: 600,
      CHECKPOINT_INTERVAL: 720,
      SEGMENT_LENGTH: 3_153_600,
      RESOLVER_QUORUM: 2,
      ANCHOR_QUORUM: 2,
      ANCHOR_STALENESS_LIMIT_SEC: 172_800,
      // The launch freeze's second half (2026-08-14). The height and the
      // four addresses are the operator-supplied battery cast; launch
      // replaces them in a second freeze that edits these exact literals
      // (tasks/08 step 7). Compact form: parseAddress strips the spaces.
      LAUNCH_HEIGHT: 58_842_720,
      TREASURY_ADDRESS: 'NQ28TKBFVF67HP8RY8125FNMNNDNTS7QF5G3',
      PROTOCOL_ADDRESS: 'NQ38NKD47ALGYRDQDXL8PARE7JRSJGJDMAU8',
      ADMIN_ADDRESS: 'NQ806XNVJDFYYEKFHMM3UCYKVBLP7H6YFNXS',
      MARKETPLACE_ADDRESS: 'NQ71TPMVQN9DMV6A1HX1NL2Q4CJG5J8MQPTB',
      BURN_ADDRESS: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
    })
  })

  it('keeps the four §3 role addresses pairwise distinct (§3, §10.6)', () => {
    // The check `defineConfig` ran at every startup, asserted once now that
    // the values are literals: the treasury/protocol split is what makes the
    // burn base exact, the admin key is cold while the treasury is hot, and
    // the marketplace is "distinct from both".
    const roles = [
      CONSTANTS.TREASURY_ADDRESS,
      CONSTANTS.PROTOCOL_ADDRESS,
      CONSTANTS.ADMIN_ADDRESS,
      CONSTANTS.MARKETPLACE_ADDRESS,
    ]
    expect(new Set(roles).size).toBe(roles.length)
    // And none of them is the burn address, which decodes to the §8.1
    // "unset" sentinel of 20 zero bytes.
    for (const role of roles) expect(role).not.toBe(parseAddress(CONSTANTS.BURN_ADDRESS))
  })

  it('sits LAUNCH_HEIGHT above the PoS genesis, where batch numbering starts', () => {
    expect(CONSTANTS.LAUNCH_HEIGHT).toBeGreaterThan(3_456_000)
  })

  it('equals the published RESERVED_NAMES list, as a set — order is not protocol (§4.1)', () => {
    // The same inline-literal pin as above, with one difference that is the
    // whole point: it compares **sets**. Rule 6 is exact-match membership, so
    // resorting the constant — or inserting an entry in the middle rather than
    // at the end — must never be a protocol change or a red CI run. Length is
    // asserted against the literal too, which is what catches a duplicate that
    // set comparison alone would swallow.
    const published = [
      'abuse',
      'admin',
      'amazon',
      'apple',
      'binance',
      'bitcoin',
      'bitfinex',
      'bitget',
      'bybit',
      'circle',
      'coinbase',
      'contact',
      'crypto',
      'discord',
      'ethereum',
      'exchange',
      'exodus',
      'facebook',
      'foundation',
      'github',
      'google',
      'kraken',
      'kucoin',
      'ledger',
      'market',
      'marketplace',
      'mastercard',
      'metamask',
      'microsoft',
      'money',
      'names',
      'nimiq',
      'nimiqhub',
      'nimiqpay',
      'official',
      'paypal',
      'phantom',
      'polygon',
      'postmaster',
      'protocol',
      'register',
      'revolut',
      'security',
      'selfcrypto',
      'solana',
      'sonar',
      'staking',
      'store',
      'stripe',
      'support',
      'system',
      'telegram',
      'tether',
      'treasury',
      'trezor',
      'trustwallet',
      'validator',
      'wallet',
    ]
    expect(new Set(CONSTANTS.RESERVED_NAMES)).toEqual(new Set(published))
    expect(CONSTANTS.RESERVED_NAMES).toHaveLength(published.length)
    expect(new Set(CONSTANTS.RESERVED_NAMES).size).toBe(CONSTANTS.RESERVED_NAMES.length)
    expect(published).toHaveLength(58)
  })

  it('keeps every published entry registrable, so no entry reserves nothing', () => {
    // An entry that no `G` could ever carry — uppercase, too short, a digit in
    // the wrong place — silently reserves nothing at all: the name it looks
    // like stays registrable and nobody finds out until it is taken. §4.1
    // never normalises, so this is exact.
    for (const name of CONSTANTS.RESERVED_NAMES) {
      expect(validateNameSyntax(name), name).toEqual({ ok: true })
      expect(name.length, name).toBeGreaterThanOrEqual(CONSTANTS.MIN_NAME_LEN)
      expect(name, name).toBe(name.toLowerCase())
    }
  })

  it('leaves the published list to the names the by-rule route cannot reach', () => {
    // 1–4 character names are members by rule (§4.1, r18) and are deliberately
    // not materialised. An entry here would be either redundant or, worse,
    // read as the list being the only route.
    expect(CONSTANTS.RESERVED_NAMES.filter((name) => name.length < CONSTANTS.MIN_NAME_LEN)).toEqual([])
  })

  it('freezes the list itself, not just the object holding it', () => {
    // Object.freeze is shallow; a frozen CONSTANTS with a live array is a
    // consensus input any caller could push onto.
    expect(Object.isFrozen(CONSTANTS.RESERVED_NAMES)).toBe(true)
  })
})
