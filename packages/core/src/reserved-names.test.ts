import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { render, SOURCE, TARGET, readNames } from '../scripts/gen-reserved-names.js'
import { RESERVED_NAMES } from './reserved-names.js'

/**
 * `reserved-names.json` is the authoring format; `reserved-names.ts` is what
 * ships. Nothing reads the JSON at runtime — §4.1 rule 6 is a consensus input,
 * and a list loaded from disk is a list two operators can hold different copies
 * of, with the disagreement first appearing as a `QUORUM_ROOT_MISMATCH` in
 * somebody's client. The cost of compiling it in is that the two can drift, so
 * that is what these tests are.
 */
describe('reserved-names.json → reserved-names.ts', () => {
  it('is what the generator would produce right now', () => {
    // An edit to the JSON that was never regenerated is a silent no-op: the
    // build keeps enforcing the old list and the diff looks done.
    expect(readFileSync(TARGET, 'utf8')).toBe(render())
  })

  it('holds the same names as the compiled constant, as a set', () => {
    const authored = readNames(readFileSync(SOURCE, 'utf8'))
    expect(new Set(RESERVED_NAMES)).toEqual(new Set(authored))
    expect(RESERVED_NAMES).toHaveLength(authored.length)
  })

  it('sorts on the way through, so resorting the JSON is not a change', () => {
    const authored = readNames(readFileSync(SOURCE, 'utf8'))
    const shuffled = JSON.stringify({ names: [...authored].reverse() })
    expect(readNames(shuffled)).toEqual(authored)
    expect(render(readNames(shuffled))).toBe(render(authored))
  })
})
