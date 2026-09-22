import { CONSTANTS, initialState, parseAddress } from '@nimiqnames/core'
import { describe, expect, it } from 'vitest'

import { LAST_CALL_LEAD, RENEW_WINDOW, milestoneAt, renewalsDue } from './milestones.js'

const EXPIRY = 70_000_000
const G = CONSTANTS.GRACE_PERIOD

describe('milestoneAt', () => {
  it('is silent until RENEW_WINDOW before expiry, then names the latest threshold reached', () => {
    expect(milestoneAt(EXPIRY, EXPIRY - RENEW_WINDOW - 1)).toBeNull()
    expect(milestoneAt(EXPIRY, EXPIRY - RENEW_WINDOW)).toBe('renewal_open')
    expect(milestoneAt(EXPIRY, EXPIRY - 1)).toBe('renewal_open')
    // §7.3 half-open: grace begins at expiry itself.
    expect(milestoneAt(EXPIRY, EXPIRY)).toBe('grace_begun')
    expect(milestoneAt(EXPIRY, EXPIRY + G - LAST_CALL_LEAD - 1)).toBe('grace_begun')
    expect(milestoneAt(EXPIRY, EXPIRY + G - LAST_CALL_LEAD)).toBe('last_call')
    expect(milestoneAt(EXPIRY, EXPIRY + G - 1)).toBe('last_call')
    expect(milestoneAt(EXPIRY, EXPIRY + G)).toBeNull()
  })

  it('derives every threshold from CONSTANTS', () => {
    expect(RENEW_WINDOW).toBe(2 * CONSTANTS.GRACE_PERIOD)
    expect(LAST_CALL_LEAD).toBe(Math.floor(CONSTANTS.GRACE_PERIOD / 4))
  })
})

describe('renewalsDue', () => {
  it('lists the names with a milestone and skips a lifetime term', () => {
    const owner = parseAddress('NQ57 B9KP 90CE KELB BGNF TKLY C0QG 3LM3 EH2H')
    const base = initialState()
    const record = (name: string, expiry: number) => ({ name, owner, target: owner, expiry, status: 'REGISTERED' as const, host: '', evm: '' })
    const state = {
      ...base,
      names: new Map([
        ['soon', record('soon', EXPIRY)],
        ['later', record('later', EXPIRY + CONSTANTS.TERM_LENGTH)],
        ['forever', record('forever', EXPIRY + CONSTANTS.LIFETIME_TERMS * CONSTANTS.TERM_LENGTH)],
      ]),
    }
    expect(renewalsDue(state, EXPIRY - 10)).toEqual([
      { milestone: 'renewal_open', owner: 'NQ57 B9KP 90CE KELB BGNF TKLY C0QG 3LM3 EH2H', name: 'soon', expiry: EXPIRY },
    ])
    expect(renewalsDue(state, EXPIRY - RENEW_WINDOW - 1)).toEqual([])
  })
})
