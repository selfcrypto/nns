/**
 * The wording rules of docs/app-states.md §5 are decided, not stylistic —
 * these tests pin the ones a later edit would most plausibly break.
 */
import { describe, expect, it } from 'vitest'
import {
  WARNING_TEXT,
  WARNING_TONE,
  alarmBody,
  delegateFailedLine,
  graceLine,
  invalidQueryLine,
  parentNotDelegatingLine,
  verifiedByLine,
} from './wording'

describe('"Verified by N resolvers" (resolver README decision, 2026-08-14)', () => {
  it('is singular at 1 and names the operator', () => {
    const line = verifiedByLine({ required: 1, queried: 1, agreed: 1, resolvers: ['Example Labs'] })
    expect(line).toBe('Verified by 1 resolver — Example Labs')
  })

  it('never says "unverified" about a healthy answer', () => {
    const line = verifiedByLine({ required: 1, queried: 1, agreed: 1, resolvers: ['Example Labs'] })
    expect(line.toLowerCase()).not.toContain('unverified')
  })

  it('is plural with no operator name above 1', () => {
    expect(verifiedByLine({ required: 2, queried: 2, agreed: 2, resolvers: ['A', 'B'] })).toBe('Verified by 2 resolvers')
  })
})

describe('delegate failures are attributed to the host, never the subdomain', () => {
  it('never claims the subdomain does not exist', () => {
    for (const line of [delegateFailedLine('exchange'), parentNotDelegatingLine('exchange')]) {
      expect(line.toLowerCase()).not.toContain('does not exist')
      expect(line.toLowerCase()).not.toContain('doesn’t exist')
      expect(line.toLowerCase()).not.toContain('not found')
    }
  })

  it('names the parent, whose half of the answer is proven', () => {
    expect(delegateFailedLine('exchange')).toContain('exchange')
  })
})

describe('tones (alarm vocabulary is reserved)', () => {
  it('no resolver warning maps to the alarm tone — warnings never halt', () => {
    for (const tone of Object.values(WARNING_TONE)) {
      expect(tone).not.toBe('alarm')
    }
  })

  it('depth states read as depth: no alarm words in their text', () => {
    for (const code of ['PROOF_PENDING', 'ANCHOR_QUORUM_NOT_MET', 'TARGET_CHANGED_SINCE_CHECKPOINT'] as const) {
      const text = WARNING_TEXT[code].toLowerCase()
      for (const forbidden of ['warning', 'danger', 'unverified', 'wrong', 'divergence', 'do not pay']) {
        expect(text).not.toContain(forbidden)
      }
    }
  })

  it('halting failures do use the reserved vocabulary', () => {
    expect(alarmBody('PROOF_INVALID').toLowerCase()).toContain('do not pay')
  })
})

describe('state lines', () => {
  it('grace is neither gone nor free', () => {
    const line = graceLine('≈ Sep 15, 2026').toLowerCase()
    expect(line).toContain('not available')
    expect(line).toContain('renew')
  })

  it('the short-name refusal explains reservation, not invalidity (§4.1 r18)', () => {
    expect(invalidQueryLine('BAD_NAME', 'TOO_SHORT').toLowerCase()).toContain('reserved')
  })
})
