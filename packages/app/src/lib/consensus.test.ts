import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseConsensus } from './consensus'

describe('parseConsensus', () => {
  it('takes the node at its word', () => {
    expect(parseConsensus(true)).toBe(true)
    expect(parseConsensus(false)).toBe(false)
  })

  /**
   * Anything that is not a boolean is "we did not get an answer", never
   * `false`. "Could not reach the relay" and "the node says it has no
   * consensus" are different facts and the panel says different things about
   * them; collapsing the first into the second reports an outage that may not
   * exist.
   */
  it('reads a non-boolean as no answer, not as a negative', () => {
    expect(parseConsensus(null)).toBeNull()
    expect(parseConsensus(undefined)).toBeNull()
    expect(parseConsensus('true')).toBeNull()
    expect(parseConsensus(1)).toBeNull()
    expect(parseConsensus({ data: true })).toBeNull()
  })
})

/**
 * The property this file exists to keep. A chain-height readout shipped on
 * 2026-09-16 polling every second, per client, and had to be reverted the
 * same day: the cost of anything on a timer here multiplies by the number of
 * open apps, against one node behind one credential. A test rather than a
 * comment, because the next person to want a live number will edit this file.
 */
describe('the node light is asked once, never polled', () => {
  const source = readFileSync(new URL('./consensus.ts', import.meta.url), 'utf8')
  const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('sets no timer', () => {
    expect(code).not.toMatch(/setInterval|setTimeout/)
  })

  it('memoises the ask, so mounting twice does not ask twice', () => {
    expect(code).toMatch(/asked \?\?=/)
  })
})
