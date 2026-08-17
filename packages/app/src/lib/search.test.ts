import { describe, expect, it } from 'vitest'
import { CONSTANTS } from '@nns/core'
import { parseSearchQuery } from './search'

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
