import { describe, expect, it } from 'vitest'
import { addressFromOutcome, readAddressField } from './addressField'
import type { SearchOutcome } from './search'

const OWNER = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000'

/**
 * The field that refused a name. `X` and `S` both record an address, so the
 * field still hands `prepareAction` an address — but a user typing `rico` is
 * naming a destination, not failing to type an address, and NNS of all
 * services has to read it that way (Kike, 2026-09-15).
 */
describe('readAddressField', () => {
  it('takes an address and returns the spaced form a review line uses', () => {
    expect(readAddressField(OWNER)).toEqual({ kind: 'address', address: OWNER })
    expect(readAddressField(OWNER.replace(/ /g, ''))).toEqual({ kind: 'address', address: OWNER })
    expect(readAddressField(`  ${OWNER}  `)).toEqual({ kind: 'address', address: OWNER })
  })

  it('reads a name as a name, never as a failed address', () => {
    expect(readAddressField('rico')).toEqual({ kind: 'name', query: 'rico' })
    expect(readAddressField('RicoMaverick')).toEqual({ kind: 'name', query: 'ricomaverick' })
    expect(readAddressField('donate.ricomaverick')).toEqual({ kind: 'name', query: 'donate.ricomaverick' })
  })

  it('still calls a half-typed address an address, because a name cannot start NQ', () => {
    // §4.1 names are lowercase, so the prefix is unambiguous: this is the one
    // place the old "is not a Nimiq address" line is the right thing to say.
    expect(readAddressField('NQ07 0000')).toEqual({ kind: 'fault', fault: 'address' })
    expect(readAddressField('nq07 0000 0000')).toEqual({ kind: 'fault', fault: 'address' })
  })

  it('reports a string that is neither, by the reason the field can state', () => {
    expect(readAddressField('not a name!')).toMatchObject({ kind: 'fault' })
    expect(readAddressField('a.b.c')).toEqual({ kind: 'fault', fault: { kind: 'many-dots' } })
  })

  it('is empty on empty, so an untouched sheet shows no error at all', () => {
    expect(readAddressField('   ')).toEqual({ kind: 'empty' })
  })
})

describe('addressFromOutcome', () => {
  const resolved = (verification: 'PROVEN' | 'DELEGATED'): SearchOutcome =>
    ({
      kind: 'resolved',
      result: { address: OWNER.replace(/ /g, ''), verification },
      info: null,
    }) as unknown as SearchOutcome

  it('fills the field from a proven answer', () => {
    expect(addressFromOutcome(resolved('PROVEN'), 'rico')).toEqual({
      kind: 'address',
      address: OWNER,
      from: 'rico',
      delegated: false,
    })
  })

  it('takes a delegated answer and marks it, rather than refusing a subdomain', () => {
    // The address is the host's word (§8.6). Refusing it would be the same
    // "we don't take names" complaint one level down; passing it off as
    // proven would be worse. The field takes it and says whose it is.
    expect(addressFromOutcome(resolved('DELEGATED'), 'donate.rico')).toMatchObject({ kind: 'address', delegated: true })
  })

  it('says a name is unregistered rather than that it is not an address', () => {
    const outcome = { kind: 'availability', name: 'rico', availability: {}, info: null } as unknown as SearchOutcome
    expect(addressFromOutcome(outcome, 'rico')).toEqual({ kind: 'none', line: 'rico isn’t registered, so it has no address.' })
  })

  it('separates "no address" from "could not check"', () => {
    const grace = { kind: 'grace', name: 'rico', info: null } as unknown as SearchOutcome
    const down = { kind: 'unreachable', code: 'NETWORK', message: '', replies: [] } as SearchOutcome
    expect(addressFromOutcome(grace, 'rico').kind).toBe('none')
    expect(addressFromOutcome(grace, 'rico')).not.toEqual(addressFromOutcome(down, 'rico'))
    expect(addressFromOutcome(down, 'rico')).toEqual({ kind: 'none', line: 'Couldn’t check rico just now.' })
  })
})
