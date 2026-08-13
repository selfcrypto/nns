import { describe, expect, it } from 'vitest'
import { CONSTANTS, LUNA_PER_NIM } from './constants.js'

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

  it('makes the recovery timelock strictly longer than the transfer timelock (§6 R, X)', () => {
    // The recovery path must give a live owner more time to veto than the
    // ordinary transfer path, or recovery becomes the faster theft route.
    expect(CONSTANTS.RECOVERY_TIMELOCK).toBeGreaterThan(CONSTANTS.XFER_TIMELOCK)
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
    expect(CONSTANTS).toStrictEqual({
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
      RECOVERY_TIMELOCK: 259_200,
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
      ANCHOR_STALENESS_LIMIT_SEC: 7_200,
      BURN_ADDRESS: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
    })
  })
})
