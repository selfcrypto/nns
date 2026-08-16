import { describe, expect, it } from 'vitest'
import { approxDate, blocksApprox, ellipsizeAddress, formatApproxDate, lunaToNim } from './format'

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
