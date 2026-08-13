import { describe, expect, it } from 'vitest'
import { CONSTANTS, LUNA_PER_NIM, PROFILES, isProfileName } from './constants.js'

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
})

describe('PROFILES — named constants profiles', () => {
  /** The ten fields a profile may vary. Everything else must be identical. */
  const PROFILED = new Set([
    'XFER_TIMELOCK',
    'RECOVERY_TIMELOCK',
    'GOVERNANCE_DELAY',
    'TERM_LENGTH',
    'GRACE_PERIOD',
    'OFFER_IRREVOCABLE',
    'OFFER_MAX_LIFETIME',
    'CHECKPOINT_INTERVAL',
    'FEE_STANDARD',
    'FEE_LONG',
  ])

  it('mainnet is CONSTANTS itself — the same frozen object, not a copy', () => {
    expect(PROFILES.mainnet).toBe(CONSTANTS)
  })

  it('is frozen at both levels', () => {
    expect(Object.isFrozen(PROFILES)).toBe(true)
    expect(Object.isFrozen(PROFILES.fast)).toBe(true)
  })

  it('fast divides the eight waiting periods by 1000, to the nearest block, never below one', () => {
    expect(PROFILES.fast.XFER_TIMELOCK).toBe(43) //             43 200 / 1000, rounded
    expect(PROFILES.fast.RECOVERY_TIMELOCK).toBe(259)
    expect(PROFILES.fast.GOVERNANCE_DELAY).toBe(43)
    expect(PROFILES.fast.TERM_LENGTH).toBe(157_680)
    expect(PROFILES.fast.GRACE_PERIOD).toBe(7_776)
    expect(PROFILES.fast.OFFER_IRREVOCABLE).toBe(9) //          8.64 rounded up
    expect(PROFILES.fast.OFFER_MAX_LIFETIME).toBe(1_296)
    expect(PROFILES.fast.CHECKPOINT_INTERVAL).toBe(1) //        0.72, floored at one block
  })

  it('fast divides the fee bands by 100', () => {
    expect(PROFILES.fast.FEE_STANDARD).toBe(4_000_000n) //     40 NIM
    expect(PROFILES.fast.FEE_LONG).toBe(400_000n) //            4 NIM
  })

  it('changes nothing else — the 64-byte ceiling and every other value are the chain’s or the protocol’s shape', () => {
    for (const key of Object.keys(CONSTANTS) as (keyof typeof CONSTANTS)[]) {
      if (!PROFILED.has(key)) expect(PROFILES.fast[key], key).toBe(CONSTANTS[key])
    }
    expect(PROFILES.fast.MAX_DATA_BYTES).toBe(64)
  })

  it('preserves under fast every ordering the mainnet suite above pins', () => {
    const fast = PROFILES.fast
    expect(fast.RECOVERY_TIMELOCK).toBeGreaterThan(fast.XFER_TIMELOCK)
    expect(fast.OFFER_IRREVOCABLE).toBeLessThan(fast.OFFER_MAX_LIFETIME)
    expect(fast.FEE_LONG).toBeLessThanOrEqual(fast.FEE_STANDARD)
    for (const fee of [fast.FEE_STANDARD, fast.FEE_LONG]) {
      expect(fee).toBeGreaterThanOrEqual(fast.PRICE_FLOOR)
      expect(fee).toBeLessThanOrEqual(fast.PRICE_CEILING)
    }
  })

  it('isProfileName admits exactly the profile names', () => {
    expect(isProfileName('mainnet')).toBe(true)
    expect(isProfileName('fast')).toBe(true)
    expect(isProfileName('devnet')).toBe(false)
    expect(isProfileName('')).toBe(false)
  })
})
