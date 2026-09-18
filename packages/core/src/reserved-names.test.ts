import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { flatten, parseCategory, readCategories, readNames, render, TARGET } from '../scripts/gen-reserved-names.js'
import { RESERVED_NAMES } from './reserved-names.js'

/**
 * `reserved-names/*.json` is the authoring format; `reserved-names.ts` is what
 * ships. Nothing reads the JSON at runtime — §4.1 rule 6 is a consensus input,
 * and a list loaded from disk is a list two operators can hold different copies
 * of, with the disagreement first appearing as a `QUORUM_ROOT_MISMATCH` in
 * somebody's client. The cost of compiling it in is that the two can drift, so
 * that is what these tests are.
 */
describe('reserved-names/*.json → reserved-names.ts', () => {
  it('is what the generator would produce right now', () => {
    // An edit to a category that was never regenerated is a silent no-op: the
    // build keeps enforcing the old list and the diff looks done.
    expect(readFileSync(TARGET, 'utf8')).toBe(render())
  })

  it('holds the same names as the compiled constant, as a set', () => {
    const authored = readNames()
    expect(new Set(RESERVED_NAMES)).toEqual(new Set(authored))
    expect(RESERVED_NAMES).toHaveLength(authored.length)
  })

  it('reserves speculative entries exactly like the rest', () => {
    // `speculative` marks the first candidates for a `U`; it is not a softer
    // reservation, and a generator that dropped it would unreserve them all.
    const speculative = [...readCategories().values()].flatMap((c) => c.speculative ?? [])
    const reserved = new Set(RESERVED_NAMES)
    expect(speculative.filter((n) => !reserved.has(n))).toEqual([])
  })

  it('makes category and file order irrelevant — a name in two categories is one entry', () => {
    const a = { tier: 'HOLD' as const, title: 'a', source: 's', names: ['zeta', 'alpha'] }
    const b = { tier: 'AWARD' as const, title: 'b', source: 's', names: ['alpha'], speculative: ['mid'] }
    expect(flatten([a, b])).toEqual(['alpha', 'mid', 'zeta'])
    expect(render(flatten([b, a]))).toBe(render(flatten([a, b])))
  })

  it('refuses a category without a tier, a title or a source', () => {
    // The per-category source is the point of the format: it is what lets the
    // next pass repeat the work instead of re-guessing it.
    expect(() => parseCategory('x.json', JSON.stringify({ tier: 'HOLD', title: 't', names: [] }))).toThrow(/source/)
    expect(() => parseCategory('x.json', JSON.stringify({ tier: 'KEEP', title: 't', source: 's', names: [] }))).toThrow(/tier/)
    expect(() => parseCategory('x.json', JSON.stringify({ tier: 'HOLD', title: 't', source: 's', names: [1] }))).toThrow(/names/)
  })
})
