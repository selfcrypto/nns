import { describe, expect, it } from 'vitest'
import {
  ADDRESS_BYTES,
  AddressError,
  ZERO_ADDRESS,
  addressFromBytes,
  addressToBytes,
  formatAddress,
  parseAddress,
  tryParseAddress,
} from './address.js'
import { CONSTANTS } from './constants.js'

/** From the project README. */
const KIKE = 'NQ64 VFXQ TPAS 5Q7S ADEX 072S CR2M QCQ4 8P8M'

describe('parseAddress', () => {
  it('accepts the conventional spaced form', () => {
    expect(parseAddress(KIKE)).toBe('NQ64VFXQTPAS5Q7SADEX072SCR2MQCQ48P8M')
  })

  it('accepts the compact form and lowercase input', () => {
    expect(parseAddress('nq64vfxqtpas5q7sadex072scr2mqcq48p8m')).toBe(parseAddress(KIKE))
  })

  it('accepts the canonical burn address from §3', () => {
    expect(parseAddress(CONSTANTS.BURN_ADDRESS)).toBe(ZERO_ADDRESS)
  })

  it.each([
    ['wrong length', 'NQ64 VFXQ'],
    ['wrong prefix', 'XX64VFXQTPAS5Q7SADEX072SCR2MQCQ48P8M'],
    ['non-numeric check digits', 'NQXXVFXQTPAS5Q7SADEX072SCR2MQCQ48P8M'],
    ['character outside the alphabet', 'NQ64IFXQTPAS5Q7SADEX072SCR2MQCQ48P8M'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseAddress(input)).toThrow(AddressError)
  })

  it('rejects a mutated checksum', () => {
    expect(() => parseAddress('NQ65VFXQTPAS5Q7SADEX072SCR2MQCQ48P8M')).toThrow(/checksum is 65, expected 64/)
  })

  it('rejects a mutated body, because the checksum no longer matches', () => {
    expect(() => parseAddress('NQ64VFXQTPAS5Q7SADEX072SCR2MQCQ48P8N')).toThrow(AddressError)
  })

  it('tryParseAddress returns null instead of throwing', () => {
    expect(tryParseAddress('not an address')).toBeNull()
    expect(tryParseAddress(KIKE)).not.toBeNull()
  })
})

describe('byte conversion', () => {
  it('round-trips through 20 raw bytes', () => {
    const address = parseAddress(KIKE)
    const bytes = addressToBytes(address)
    expect(bytes).toHaveLength(ADDRESS_BYTES)
    expect(addressFromBytes(bytes)).toBe(address)
  })

  it('encodes the burn address as 20 zero bytes — the same encoding §8.1 gives an unset recovery address', () => {
    expect(addressToBytes(ZERO_ADDRESS)).toEqual(new Uint8Array(ADDRESS_BYTES))
  })

  it('rejects a byte array of the wrong length', () => {
    expect(() => addressFromBytes(new Uint8Array(19))).toThrow(AddressError)
    expect(() => addressFromBytes(new Uint8Array(21))).toThrow(AddressError)
  })

  it('round-trips every byte value through the base32 layer', () => {
    // 0x00..0x13, then 0xec..0xff — covers both ends of the byte range and
    // several 5/8-bit boundary alignments.
    for (const seed of [0, 1, 0x7f, 0x80, 0xfe, 0xff]) {
      const bytes = Uint8Array.from({ length: ADDRESS_BYTES }, (_, i) => (seed + i) & 0xff)
      expect(addressToBytes(addressFromBytes(bytes))).toEqual(bytes)
    }
  })
})

describe('formatAddress', () => {
  it('restores the conventional spacing', () => {
    expect(formatAddress(parseAddress(KIKE))).toBe(KIKE)
  })

  it('formats the burn address exactly as §3 writes it', () => {
    expect(formatAddress(ZERO_ADDRESS)).toBe(CONSTANTS.BURN_ADDRESS)
  })
})
