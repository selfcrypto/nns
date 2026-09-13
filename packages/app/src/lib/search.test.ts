import { describe, expect, it } from 'vitest'
import { CONSTANTS } from '@nimiqnames/core'
import { isShortName, parseSearchQuery, queryFault } from './search'

/**
 * The one rule this file exists for: rule 6 is not the client's to apply.
 * Applying it here made every `RESERVED_NAMES` member unsearchable in the
 * app, `U`-released ones included — which is the whole point of a `U`.
 */
describe('parseSearchQuery', () => {
  it('accepts a listed reserved name — release is chain state the browser cannot see', () => {
    expect(CONSTANTS.RESERVED_NAMES).toContain('nimiq')
    const parsed = parseSearchQuery('nimiq')
    expect(parsed).toEqual({ ok: true, query: { kind: 'name', name: 'nimiq' } })
  })

  it('accepts a well-formed short name (§4.1, r18) — reserved by rule, releasable, so searchable', () => {
    expect(parseSearchQuery('nq').ok).toBe(true)
  })

  it('still refuses a short name that no `U` could ever release', () => {
    // Fails rules 2–5, so it is on neither membership route: not reserved,
    // just invalid, and TOO_SHORT is how §4.1 says so.
    expect(parseSearchQuery('-ab')).toEqual({ ok: false, reason: 'BAD_NAME', detail: 'TOO_SHORT' })
  })

  it('still refuses rules 1–5 failures at full length', () => {
    expect(parseSearchQuery('-bad-')).toEqual({ ok: false, reason: 'BAD_NAME', detail: 'LEADING_HYPHEN' })
    expect(parseSearchQuery('na--me')).toEqual({ ok: false, reason: 'BAD_NAME', detail: 'DOUBLE_HYPHEN' })
    expect(parseSearchQuery('a'.repeat(CONSTANTS.MAX_NAME_LEN + 1))).toEqual({
      ok: false,
      reason: 'BAD_NAME',
      detail: 'TOO_LONG',
    })
  })

  it('neutralises rule 6 on the parent of a dotted query, not on the label', () => {
    expect(parseSearchQuery('pay.nimiq')).toEqual({ ok: true, query: { kind: 'dotted', label: 'pay', parent: 'nimiq' } })
    expect(parseSearchQuery('-pay.nimiq')).toEqual({ ok: false, reason: 'BAD_LABEL', detail: 'LEADING_HYPHEN' })
  })

  it('keeps §4.4 to one dot', () => {
    expect(parseSearchQuery('a.b.c')).toEqual({ ok: false, reason: 'TOO_MANY_DOTS', detail: null })
  })
})

/**
 * Every case here was a wrong message on the live deployment (Kike,
 * 2026-08-17). The table is the regression suite: core's first failing code is
 * not the rule a user can act on.
 */
describe('queryFault', () => {
  it('names the rule a short malformed string actually broke, never its length', () => {
    // All of these arrived as TOO_SHORT and were rendered "Names this short are
    // reserved" — which is also the opposite of the truth about them: failing
    // rules 2–5 puts a short name on neither membership route, so no `U` can
    // ever release it (the reducer forfeits INVALID_NAME).
    expect(queryFault('??')).toEqual({ kind: 'name', reason: 'BAD_CHARACTER' })
    expect(queryFault('ni!')).toEqual({ kind: 'name', reason: 'BAD_CHARACTER' })
    expect(queryFault('-ab')).toEqual({ kind: 'name', reason: 'LEADING_HYPHEN' })
    expect(queryFault('1234')).toEqual({ kind: 'name', reason: 'NO_LETTER' })
    expect(queryFault('sud0')).toEqual({ kind: 'name', reason: 'BOUNDARY_DIGIT' })
    expect(queryFault('l1do')).toEqual({ kind: 'name', reason: 'INTERIOR_DIGIT' })
  })

  it('reports a dot with an empty side as a shape, not as a rule on a string nobody typed', () => {
    // parseQuery validates the empty side: `.shopper` came out a *label* rule
    // and `shopper.` a *name* rule, both about ''.
    for (const query of ['.', '.shopper', 'shopper.', 'pay.']) {
      expect(queryFault(query), query).toEqual({ kind: 'dot-shape' })
    }
  })

  it('keeps the faults that were already right', () => {
    expect(queryFault('a.b.c')).toEqual({ kind: 'many-dots' })
    expect(queryFault('na--me')).toEqual({ kind: 'name', reason: 'DOUBLE_HYPHEN' })
    expect(queryFault('nimiq shop')).toEqual({ kind: 'name', reason: 'BAD_CHARACTER' })
    expect(queryFault('nim1q')).toEqual({ kind: 'name', reason: 'INTERIOR_DIGIT' })
    expect(queryFault('a'.repeat(CONSTANTS.MAX_NAME_LEN + 1))).toEqual({ kind: 'name', reason: 'TOO_LONG' })
    expect(queryFault('-pay.nimiq')).toEqual({ kind: 'label', reason: 'LEADING_HYPHEN' })
  })

  it('refuses nothing the server should answer', () => {
    // A well-formed short name is releasable, a listed one may already be
    // released, and both must reach the network.
    for (const query of ['nim', 'ni', 'web3', 'nimiq', 'pay.nimiq', 'pay.nim', '2nimiq2', 'bitcoin7', '']) {
      expect(queryFault(query), query).toBeNull()
    }
  })
})

describe('isShortName', () => {
  it('is a length test, not rule 6', () => {
    expect(isShortName('nim')).toBe(true)
    expect(isShortName('nimi')).toBe(true)
    // Listed in RESERVED_NAMES, and still not short: reading the list here is
    // exactly the mistake this predicate exists to avoid.
    expect(CONSTANTS.RESERVED_NAMES).toContain('nimiq')
    expect(isShortName('nimiq')).toBe(false)
    expect(isShortName('')).toBe(false)
  })

  it('measures the parent of a dotted query — §4.4 labels floor at 1', () => {
    expect(isShortName('pay.nim')).toBe(true)
    expect(isShortName('p.nimiq')).toBe(false)
  })
})
