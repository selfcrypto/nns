import { describe, expect, it } from 'vitest'
import { parseAddress, tryParseEvmAddress } from '@nimiqnames/core'
import { EXAMPLE_PROFILES } from './examples'

describe('the landing marquee’s example profiles are illustrations', () => {
  it('carries five distinct names and five distinct addresses', () => {
    expect(EXAMPLE_PROFILES).toHaveLength(5)
    expect(new Set(EXAMPLE_PROFILES.map((p) => p.name)).size).toBe(5)
    expect(new Set(EXAMPLE_PROFILES.map((p) => p.address)).size).toBe(5)
    expect(new Set(EXAMPLE_PROFILES.map((p) => p.evm)).size).toBe(5)
  })

  it('shows no address a wallet would accept', () => {
    for (const profile of EXAMPLE_PROFILES) {
      // Well-formed enough to illustrate an address, and refused by the chain's
      // own checksum — the picture cannot become a payment.
      expect(profile.address).toMatch(/^NQ\d{2}(?: [0-9A-HJ-NP-VXY]{4}){8}$/)
      expect(() => parseAddress(profile.address)).toThrow(/checksum/)
      expect(profile.evm).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(tryParseEvmAddress(profile.evm)).toBeNull()
    }
  })

  it('does not point five names at the same nothing', () => {
    for (const profile of EXAMPLE_PROFILES) {
      expect(profile.address).not.toMatch(/0000 0000/)
      expect(profile.evm).not.toMatch(/00000000/)
    }
  })
})
