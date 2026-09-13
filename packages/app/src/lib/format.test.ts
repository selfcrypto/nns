import { describe, expect, it } from 'vitest'
import { approxDate, blocksApprox, displayAddress, ellipsizeAddress, formatApproxDate, lunaToNim } from './format'

describe('lunaToNim', () => {
  it('renders whole NIM without decimals and fractions trimmed', () => {
    expect(lunaToNim(200_000_000n)).toBe('2000')
    expect(lunaToNim(100_000n)).toBe('1')
    expect(lunaToNim(150_000n)).toBe('1.5')
    expect(lunaToNim(1n)).toBe('0.00001')
    expect(lunaToNim(0n)).toBe('0')
  })
})

describe('approx dates', () => {
  it('projects a future height at ~1 s per block and renders as an estimate', () => {
    const nowMs = Date.UTC(2026, 7, 16)
    const date = approxDate(1_086_400, 1_000_000, nowMs)
    expect(date.getTime()).toBe(nowMs + 86_400_000)
    expect(formatApproxDate(date, 'en-US')).toMatch(/^≈ /)
  })

  it('blocksApprox picks a sensible unit', () => {
    expect(blocksApprox(43_200)).toBe('~12 h')
    expect(blocksApprox(2_592_000)).toBe('~30 d')
    expect(blocksApprox(720)).toBe('~12 min')
  })
})

describe('ellipsizeAddress', () => {
  it('keeps the first two and last groups of a spaced address', () => {
    expect(ellipsizeAddress('NQ34 248H 248H 248H 248H 248H 248H 248H 248H')).toBe('NQ34 248H … 248H')
  })

  it('leaves anything unexpected alone', () => {
    expect(ellipsizeAddress('nq34248h')).toBe('nq34248h')
  })
})

describe('displayAddress', () => {
  const spaced = 'NQ51 Q243 EF29 MTA3 LV3U F0JG LLP9 3SGP YXBF'

  it('spaces the compact form @nimiqnames/resolver returns', () => {
    expect(displayAddress('NQ51Q243EF29MTA3LV3UF0JGLLP93SGPYXBF')).toBe(spaced)
  })

  it('leaves the API form alone', () => {
    expect(displayAddress(spaced)).toBe(spaced)
  })

  it('returns anything unparsable untouched', () => {
    expect(displayAddress('not an address')).toBe('not an address')
  })

  it('lets ellipsizeAddress shorten a compact address', () => {
    expect(ellipsizeAddress('NQ51Q243EF29MTA3LV3UF0JGLLP93SGPYXBF')).toBe('NQ51 Q243 … YXBF')
  })
})
