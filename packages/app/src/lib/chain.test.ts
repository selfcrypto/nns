import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseHeight, registryLag } from './chain'
import { registryLagLine } from './wording'

describe('parseHeight', () => {
  it('takes a block height', () => {
    expect(parseHeight(61_402_118)).toBe(61_402_118)
  })

  /**
   * The strip renders whatever this returns. An endpoint answering a string,
   * a null or an error body that got this far must not become a height on
   * screen — the readout's whole value is that its numbers are real.
   */
  it('refuses anything that is not a height', () => {
    expect(parseHeight('61402118')).toBeNull()
    expect(parseHeight(null)).toBeNull()
    expect(parseHeight(undefined)).toBeNull()
    expect(parseHeight({ data: 61_402_118 })).toBeNull()
    expect(parseHeight(61_402_118.5)).toBeNull()
    expect(parseHeight(0)).toBeNull()
    expect(parseHeight(-1)).toBeNull()
    expect(parseHeight(Number.NaN)).toBeNull()
  })
})

describe('registryLag', () => {
  it('is the distance the registry trails the head', () => {
    expect(registryLag(61_402_118, 61_402_060)).toBe(58)
  })

  it('is null while either number is missing', () => {
    expect(registryLag(null, 61_402_060)).toBeNull()
    expect(registryLag(61_402_118, null)).toBeNull()
  })

  /**
   * The two numbers come from two services sampled at different moments, so
   * the registry can read *ahead* of a head fetched a second earlier. That is
   * a sampling artefact, and "-1 blocks behind" would be the strip reporting
   * its own polling schedule as news about the chain.
   */
  it('clamps a registry that samples ahead of a stale head', () => {
    expect(registryLag(61_402_060, 61_402_061)).toBe(0)
  })
})

describe('registryLagLine', () => {
  it('counts blocks, singular and plural', () => {
    expect(registryLagLine(1)).toBe('1 block behind')
    expect(registryLagLine(58)).toBe('58 blocks behind')
  })

  /** Caught up is not "0 blocks behind": the number is noise once it is zero. */
  it('says caught up rather than counting zero', () => {
    expect(registryLagLine(0)).toBe('up to date')
  })
})

/**
 * The strip is chrome, and chrome must not spend the relay's read budget.
 *
 * `relay/src/server.ts` gives each client IP capacity 30 refilling 60 a
 * minute. A one-second poll consumed the whole refill and 429'd the next
 * send: a Hub transfer needs `getBlockNumber` and then `sendRawTransaction`,
 * and neither could get a token. The interval is a shipped constant rather
 * than a preference, so it gets a test.
 */
describe('the poll interval fits the relay budget', () => {
  const RELAY_READ_REFILL_PER_MINUTE = 60

  it('spends at most a tenth of the sustained read refill', () => {
    const source = readFileSync(new URL('./chain.ts', import.meta.url), 'utf8')
    const declared = /const CHAIN_INTERVAL_MS = ([\d_]+)/.exec(source)?.[1]
    expect(declared).toBeDefined()

    const intervalMs = Number((declared as string).replaceAll('_', ''))
    const readsPerMinute = 60_000 / intervalMs
    expect(readsPerMinute).toBeLessThanOrEqual(RELAY_READ_REFILL_PER_MINUTE / 10)
  })
})
