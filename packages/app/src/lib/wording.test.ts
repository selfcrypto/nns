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
  parentNotDelegatingLine,
  queryFaultLine,
  shortNameNoteLine,
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

describe('pinning (the one non-halting state allowed the alarm tier)', () => {
  it('the mismatch body spends the reserved vocabulary — that is what it is reserved for', async () => {
    const { pinMismatchBody, pinFirstUseLine } = await import('./wording')
    expect(pinMismatchBody('example', '8/16/2026').toLowerCase()).toContain('do not pay')
    // First use is quiet: no alarm words on the everyday state.
    for (const forbidden of ['warning', 'stop', 'do not pay', 'unverified']) {
      expect(pinFirstUseLine().toLowerCase()).not.toContain(forbidden)
    }
  })
})

describe('a broken checker never reads as a negative result (decisions.md)', () => {
  it('the inbox-down line blames the inbox service, not resolvers, and says nothing is lost', async () => {
    const { inboxDownLine } = await import('./wording')
    const line = inboxDownLine().toLowerCase()
    expect(line).toContain('inbox service')
    expect(line).toContain('on-chain')
    expect(line).not.toContain('resolver')
  })

  it('unchecked never claims what only an answered poll can know', async () => {
    const { sendUncheckedLine, sendUnconfirmedLine } = await import('./wording')
    const unchecked = sendUncheckedLine().toLowerCase()
    // The unconfirmed line's claim — the network did not include it — is
    // exactly what a dead checker cannot assert.
    expect(sendUnconfirmedLine().toLowerCase()).toContain('did not include')
    expect(unchecked).not.toContain('did not include')
    expect(unchecked).not.toContain('fail')
    // And it must not prompt a retry: a retry re-signs a different
    // transaction and can pay a second fee.
    expect(unchecked).not.toContain('retry')
    expect(unchecked).not.toContain('try again')
  })
})

describe('state lines', () => {
  it('grace is neither gone nor free', () => {
    const line = graceLine('≈ Sep 15, 2026').toLowerCase()
    expect(line).toContain('not available')
    expect(line).toContain('renew')
  })

  it('the short-name note explains reservation, not invalidity (§4.1 r18)', () => {
    const line = shortNameNoteLine().toLowerCase()
    expect(line).toContain('reserved')
    expect(line).toContain('released')
    // The states doc §3 keeps the fired `U` out of user-facing language.
    expect(line).not.toContain('governance')
    expect(line).not.toMatch(/\bu\b/)
  })
})

/**
 * Every assertion here is a sentence that was wrong on the live deployment
 * (Kike, 2026-08-17) — "they're all really weird and mostly incorrect".
 */
describe('field wording says which rule broke, and says it truthfully', () => {
  it('states §4.2\'s boundary clause, not a rule that does not exist', () => {
    const line = queryFaultLine({ kind: 'name', reason: 'BOUNDARY_DIGIT' })
    // It used to read "Digits can only lead or trail, not both" — but 2nimiq2,
    // 9nimiq9 and 23nimiq45 are all valid. What is barred is 0 and 1 at an end.
    expect(line).toContain('0')
    expect(line).toContain('1')
    expect(line.toLowerCase()).not.toContain('not both')
  })

  it('never tells a user a malformed name is reserved', () => {
    // "Reserved" implies a `U` could open it. For a name failing rules 2–5
    // nothing ever can — the reducer forfeits INVALID_NAME at any length.
    for (const reason of ['BAD_CHARACTER', 'NO_LETTER', 'LEADING_HYPHEN', 'INTERIOR_DIGIT', 'BOUNDARY_DIGIT'] as const) {
      expect(queryFaultLine({ kind: 'name', reason }).toLowerCase(), reason).not.toContain('reserved')
    }
  })

  it('describes a dot with an empty side as a format, and shows one', () => {
    const line = queryFaultLine({ kind: 'dot-shape' })
    expect(line).toContain('label.name')
    expect(line.toLowerCase()).not.toContain('reserved')
  })

  it('never applies name rules to a label: no 5-character floor, no reservation, no letters', () => {
    for (const reason of ['TOO_SHORT', 'TOO_LONG', 'BAD_CHARACTER', 'LEADING_HYPHEN', 'TRAILING_HYPHEN', 'DOUBLE_HYPHEN'] as const) {
      const line = queryFaultLine({ kind: 'label', reason }).toLowerCase()
      expect(line, reason).not.toContain('reserved')
      expect(line, reason).not.toContain('5 characters')
      expect(line, reason).not.toContain('at least one letter')
      // Every label line says which half of the query it is about.
      expect(line, reason).toContain('dot')
    }
  })
})
