import { describe, expect, it } from 'vitest'
import {
  approxDate,
  blocksApprox,
  displayAddress,
  ellipsizeAddress,
  formatApproxDate,
  formatApproxIn,
  group,
  looksGrouped,
  lunaToNim,
  lunaToNimInput,
  splitAroundName,
} from './format'
import { parseNimAmount } from './actions'

describe('lunaToNim', () => {
  it('renders whole NIM without decimals and fractions trimmed', () => {
    expect(lunaToNim(200_000_000n)).toBe('2,000')
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
  })

  // A timelock is a countdown. Rendered through `formatApproxDate` it came out
  // as the day it already is, on mainnet's 12 h and on a tempo era's 10 min
  // alike (Kike, 2026-09-15).
  it('renders a pending effect as time left, and a due one as the next block', () => {
    expect(formatApproxIn(600)).toBe('in ~10 min')
    expect(formatApproxIn(43_200)).toBe('in ~12 h')
    expect(formatApproxIn(0)).toBe('at the next block')
    expect(formatApproxIn(-5)).toBe('at the next block')
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

describe('thousands grouping', () => {
  it('groups the integer part in threes and nothing else', () => {
    expect(group(0n)).toBe('0')
    expect(group(999n)).toBe('999')
    expect(group(1000n)).toBe('1,000')
    expect(group(1_234_567n)).toBe('1,234,567')
    expect(group(-1_234_567n)).toBe('-1,234,567')
    expect(group(12_345)).toBe('12,345')
  })

  it('never groups a fraction — those digits are precision, not magnitude', () => {
    expect(lunaToNim(1_234_567_800_000n)).toBe('12,345,678')
    expect(lunaToNim(1_234_512_345n)).toBe('12,345.12345')
    // Five decimals is the whole precision, so a fraction can never reach the
    // length where a separator would even be a question.
    expect(lunaToNim(99_999n)).toBe('0.99999')
  })
})

describe('the read form and the typed form', () => {
  it('differ in exactly one thing', () => {
    expect(lunaToNim(1_876_584_304n)).toBe('18,765.84304')
    expect(lunaToNimInput(1_876_584_304n)).toBe('18765.84304')
    expect(lunaToNim(0n)).toBe(lunaToNimInput(0n))
    expect(lunaToNim(150_000n)).toBe(lunaToNimInput(150_000n))
  })

  /**
   * The bug this pair exists for: Pay's MAX filled the amount field from the
   * *read* form, so a balance of 18,765.84304 went in and the parser rejected
   * it on the next keystroke (Kike, 2026-09-14). Anything a button puts into
   * a field has to survive the parser behind it.
   */
  it('round-trips the typed form through the parser, which is what MAX needs', () => {
    for (const luna of [0n, 1n, 150_000n, 100_000_000n, 1_876_584_304n, 123_456_789_012_345n]) {
      expect(parseNimAmount(lunaToNimInput(luna)), String(luna)).toBe(luna)
    }
  })

  it('and the read form does not, which is why the two are separate functions', () => {
    expect(() => parseNimAmount(lunaToNim(1_876_584_304n))).toThrow(/without thousands separators/)
  })
})

describe('looksGrouped', () => {
  it('catches a grouped amount with or without a fraction behind it', () => {
    for (const grouped of ['1,000', '12,345', '18,765.84304', '123,456,789', '1.234.567', '1.234.567,89']) {
      expect(looksGrouped(grouped), grouped).toBe(true)
    }
  })

  it('leaves every unambiguous amount alone', () => {
    for (const plain of ['450', '1.5', '1,5', '0.00001', '12.345', '18765.84304', '', 'abc']) {
      expect(looksGrouped(plain), plain).toBe(false)
    }
  })
})

describe('splitAroundName', () => {
  const marked = (line: string, name: string) =>
    splitAroundName(line, name)
      .filter((part) => part.isName)
      .length

  it('marks the name and leaves the rest of the sentence alone', () => {
    const parts = splitAroundName('No host will answer for subdomains under rico.', 'rico')
    expect(parts.map((part) => part.text).join('')).toBe('No host will answer for subdomains under rico.')
    expect(parts.filter((part) => part.isName)).toEqual([{ text: 'rico', isName: true }])
  })

  it('never marks the name inside a longer name or a hostname', () => {
    expect(marked('ricomaverick keeps its host.', 'rico')).toBe(0)
    expect(marked('rico.example.com will answer for everything under maverick.', 'rico')).toBe(0)
  })

  it('marks every standalone occurrence, and rejoins to the original', () => {
    const line = 'nns.example.com will answer for everything under rico, and rico keeps its own address.'
    const parts = splitAroundName(line, 'rico')
    expect(parts.map((part) => part.text).join('')).toBe(line)
    expect(marked(line, 'rico')).toBe(2)
  })
})
