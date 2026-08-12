import { describe, expect, it } from 'vitest'
import { CONSTANTS } from './constants.js'
import { feeBand, parseQuery, validateLabel, validateName } from './name.js'

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
    'rejects %s on length, not on the digit rule — the §4.2 table is about §4.2 alone',
    (name) => {
      // §4.2 lists these among its "Valid" examples and the r6 boundary-clause
      // prose names them as the casualties it was written to preserve. All are
      // under MIN_NAME_LEN, so §4.1 rule 1 rejects them first: 1–4 character
      // names are withheld for auction. They are digit-rule valid and
      // registrable-name invalid, and the table does not say so.
      expect(reason(name)).toBe('TOO_SHORT')
    },
  )

  it('accepts the same shapes once they are long enough to register', () => {
    expect(validateName('web33').ok).toBe(true)
    expect(validateName('2fact').ok).toBe(true)
  })
})

describe('validateName — §4.1 rules, in order', () => {
  it('rejects below MIN_NAME_LEN and accepts at it', () => {
    expect(reason('abcd')).toBe('TOO_SHORT')
    expect(validateName('abcde').ok).toBe(true)
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

  it('applies RESERVED_NAMES by exact match', () => {
    const reserved = new Set(['nimiq', 'binance'])
    expect(validateName('nimiq', reserved)).toEqual({ ok: false, reason: 'RESERVED' })
    expect(validateName('nimiq').ok).toBe(true)
    expect(validateName('nimiqq', reserved).ok).toBe(true)
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
    expect(parseQuery('binance')).toEqual({ ok: true, query: { kind: 'name', name: 'binance' } })
  })

  it('splits label from parent', () => {
    expect(parseQuery('alice.binance')).toEqual({
      ok: true,
      query: { kind: 'dotted', label: 'alice', parent: 'binance' },
    })
  })

  it('rejects more than one dot — nested delegation is v2', () => {
    expect(parseQuery('a.b.binance')).toEqual({ ok: false, reason: 'TOO_MANY_DOTS', detail: null })
  })

  it('requires the parent to be a valid registrable name', () => {
    expect(parseQuery('alice.b1nance')).toEqual({ ok: false, reason: 'BAD_NAME', detail: 'INTERIOR_DIGIT' })
  })

  it('rejects an empty label', () => {
    expect(parseQuery('.binance')).toEqual({ ok: false, reason: 'BAD_LABEL', detail: 'TOO_SHORT' })
  })
})
