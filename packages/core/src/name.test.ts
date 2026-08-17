import { describe, expect, it } from 'vitest'
import { CONSTANTS } from './constants.js'
import { feeBand, parseQuery, validateLabel, validateName, validateNameShape, validateNameSyntax } from './name.js'

const reason = (name: string): string | null => {
  const result = validateName(name)
  return result.ok ? null : result.reason
}

describe('validateName — §4.2 table, verbatim', () => {
  // The spec prints these two rows. If either side moves, the spec moved.
  it.each(['layer', 'bitcoin7', '21kike'])('accepts %s', (name) => {
    expect(validateName(name).ok).toBe(true)
  })

  it.each(['n1m1q', 'nimiq0pay', 'g00gle', 'b1tc0in', '1ayer', 'sud0'])('rejects %s', (name) => {
    expect(validateName(name).ok).toBe(false)
  })

  it.each(['web3', '2fa', 'x2'])(
    'rejects %s as reserved, not on the digit rule — the §4.2 table is about §4.2 alone',
    (name) => {
      // §4.2 lists these among its "Valid" examples and the r6 boundary-clause
      // prose names them as the casualties it was written to preserve. All are
      // under MIN_NAME_LEN and satisfy rules 2–5, so since r18 they are
      // reserved by rule (§4.1): held at launch, normal names once a `U`
      // releases them. They are digit-rule valid and (while held)
      // registrable-name invalid, and the table does not say so.
      expect(reason(name)).toBe('RESERVED')
      expect(validateName(name, new Set([name])).ok).toBe(true)
    },
  )

  it('accepts the same shapes once they are long enough to register', () => {
    expect(validateName('web33').ok).toBe(true)
    expect(validateName('2fact').ok).toBe(true)
  })
})

describe('validateName — §4.1 rules, in order', () => {
  it('holds well-formed names below MIN_NAME_LEN as reserved, and accepts at it', () => {
    // The floor binds only while a name is reserved (§4.1): a well-formed
    // short name is a reserved-set member by rule, and a fired U makes it a
    // normal name.
    expect(reason('abcd')).toBe('RESERVED')
    expect(validateName('abcd', new Set(['abcd'])).ok).toBe(true)
    expect(validateName('abcde').ok).toBe(true)
  })

  it('keeps TOO_SHORT for short names failing rules 2–5 — never releasable, so the floor claims them', () => {
    expect(reason('12')).toBe('TOO_SHORT') // no letter
    expect(reason('ab-')).toBe('TOO_SHORT') // trailing hyphen
    expect(reason('a0')).toBe('TOO_SHORT') // boundary digit
    // A fired U cannot exist for these, but even a claimed one changes nothing.
    expect(validateName('ab-', new Set(['ab-'])).ok).toBe(false)
  })

  it('rejects above MAX_NAME_LEN and accepts at it', () => {
    expect(validateName('a'.repeat(CONSTANTS.MAX_NAME_LEN)).ok).toBe(true)
    expect(reason('a'.repeat(CONSTANTS.MAX_NAME_LEN + 1))).toBe('TOO_LONG')
  })

  it('rejects rather than normalises uppercase', () => {
    expect(reason('Nimiq')).toBe('BAD_CHARACTER')
    expect(reason('NIMIQ')).toBe('BAD_CHARACTER')
  })

  it('rejects underscores, dots and non-ASCII', () => {
    expect(reason('my_name')).toBe('BAD_CHARACTER')
    expect(reason('my.name')).toBe('BAD_CHARACTER')
    expect(reason('café-au')).toBe('BAD_CHARACTER')
  })

  it('requires at least one letter', () => {
    expect(reason('12345')).toBe('NO_LETTER')
    expect(reason('123-45')).toBe('NO_LETTER')
  })

  it('enforces hyphen placement', () => {
    expect(reason('-abcde')).toBe('LEADING_HYPHEN')
    expect(reason('abcde-')).toBe('TRAILING_HYPHEN')
    expect(reason('ab--cde')).toBe('DOUBLE_HYPHEN')
    expect(validateName('self-crypto').ok).toBe(true)
  })

  it('applies RESERVED_NAMES by exact match, from the frozen list', () => {
    // Exact match, never a prefix or a normalisation (§4.1). The list is a
    // constant since the launch freeze, so there is no second list to pass.
    expect(validateName('nimiq')).toEqual({ ok: false, reason: 'RESERVED' })
    expect(validateName('nimiqq').ok).toBe(true)
    expect(validateName('nimiq', new Set(['nimiq'])).ok).toBe(true)
  })
})

describe('validateName — §4.2 positional digit rule', () => {
  it('permits digit runs at either end', () => {
    expect(validateName('web33').ok).toBe(true)
    expect(validateName('23kike').ok).toBe(true)
    expect(validateName('23kike99').ok).toBe(true)
  })

  it('forbids a digit between letters', () => {
    expect(reason('nim1q')).toBe('INTERIOR_DIGIT')
    expect(reason('2nim1q9')).toBe('INTERIOR_DIGIT')
  })

  it('forbids 0 or 1 at either boundary — the r6 clause', () => {
    expect(reason('nimiq0')).toBe('BOUNDARY_DIGIT')
    expect(reason('1kike')).toBe('BOUNDARY_DIGIT')
    expect(reason('0nimiq')).toBe('BOUNDARY_DIGIT')
    expect(reason('nimiq1')).toBe('BOUNDARY_DIGIT')
  })

  it('still permits the digits the clause was written to preserve', () => {
    expect(validateName('bitcoin7').ok).toBe(true)
    expect(validateName('web3dev').ok).toBe(false) // interior digit
    expect(validateName('99nimiq').ok).toBe(true)
  })

  it('reports INTERIOR_DIGIT when a name fails both clauses', () => {
    // §4.2 states the main rule first and the boundary clause "additionally",
    // so the order is fixed and vectors depend on it.
    expect(reason('1n1m1')).toBe('INTERIOR_DIGIT')
  })
})

describe('validateNameShape — rules 2–5 with no length at all', () => {
  it('answers the rule a short malformed name broke, where validateNameSyntax says TOO_SHORT', () => {
    // The reason this export exists: `validateNameSyntax` collapses all of
    // these to TOO_SHORT (deliberately — §4.2's `sud0` vector), which is right
    // for validity and useless for telling a user what to fix.
    expect(validateNameSyntax('sud0')).toEqual({ ok: false, reason: 'TOO_SHORT' })
    expect(validateNameShape('sud0')).toEqual({ ok: false, reason: 'BOUNDARY_DIGIT' })
    expect(validateNameShape('l1do')).toEqual({ ok: false, reason: 'INTERIOR_DIGIT' })
    expect(validateNameShape('??')).toEqual({ ok: false, reason: 'BAD_CHARACTER' })
    expect(validateNameShape('-ab')).toEqual({ ok: false, reason: 'LEADING_HYPHEN' })
    expect(validateNameShape('1234')).toEqual({ ok: false, reason: 'NO_LETTER' })
  })

  it('has no floor and no ceiling — so it is never a validity check on its own', () => {
    expect(validateNameShape('ab').ok).toBe(true)
    expect(validateNameShape('a'.repeat(CONSTANTS.MAX_NAME_LEN + 10)).ok).toBe(true)
    expect(validateNameSyntax('a'.repeat(CONSTANTS.MAX_NAME_LEN + 10))).toEqual({ ok: false, reason: 'TOO_LONG' })
  })

  it('agrees with validateNameSyntax above the floor', () => {
    for (const name of ['nimiq', 'nim1q', 'nimiq0', 'na--me', '-bad-', 'nimiq shop']) {
      expect(validateNameShape(name), name).toEqual(validateNameSyntax(name))
    }
  })
})

describe('feeBand — §10.1', () => {
  it('splits at LONG_NAME_LEN', () => {
    expect(feeBand('a'.repeat(CONSTANTS.LONG_NAME_LEN - 1))).toBe('STANDARD')
    expect(feeBand('a'.repeat(CONSTANTS.LONG_NAME_LEN))).toBe('LONG')
  })
})

describe('validateLabel — §4.4', () => {
  it('permits a single character, unlike a name', () => {
    expect(validateLabel('a').ok).toBe(true)
  })

  it('does not apply the positional digit rule', () => {
    expect(validateLabel('n1m1q').ok).toBe(true)
    expect(validateLabel('0alice').ok).toBe(true)
    expect(validateLabel('12345').ok).toBe(true)
  })

  it('still enforces the character set and hyphen placement', () => {
    expect(validateLabel('Alice').ok).toBe(false)
    expect(validateLabel('-alice').ok).toBe(false)
    expect(validateLabel('alice-').ok).toBe(false)
    expect(validateLabel('al--ice').ok).toBe(false)
  })

  it('enforces MAX_LABEL_LEN', () => {
    expect(validateLabel('a'.repeat(CONSTANTS.MAX_LABEL_LEN)).ok).toBe(true)
    expect(validateLabel('a'.repeat(CONSTANTS.MAX_LABEL_LEN + 1)).ok).toBe(false)
  })
})

describe('parseQuery — §4.4', () => {
  it('reads a bare name', () => {
    expect(parseQuery('kikename')).toEqual({ ok: true, query: { kind: 'name', name: 'kikename' } })
  })

  it('splits label from parent', () => {
    expect(parseQuery('alice.kikename')).toEqual({
      ok: true,
      query: { kind: 'dotted', label: 'alice', parent: 'kikename' },
    })
  })

  it('rejects more than one dot — nested delegation is v2', () => {
    expect(parseQuery('a.b.kikename')).toEqual({ ok: false, reason: 'TOO_MANY_DOTS', detail: null })
  })

  it('requires the parent to be a valid registrable name', () => {
    expect(parseQuery('alice.k1kename')).toEqual({ ok: false, reason: 'BAD_NAME', detail: 'INTERIOR_DIGIT' })
  })

  it('rejects an empty label', () => {
    expect(parseQuery('.kikename')).toEqual({ ok: false, reason: 'BAD_LABEL', detail: 'TOO_SHORT' })
  })
})
