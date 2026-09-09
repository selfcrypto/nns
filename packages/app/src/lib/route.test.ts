import { describe, expect, it } from 'vitest'
import { formatRoute, parseRoute, TABS } from './route'

describe('parseRoute', () => {
  it('an empty hash is the fallback', () => {
    expect(parseRoute('', 'home')).toEqual({ tab: 'home', param: null })
    expect(parseRoute('#', 'buy')).toEqual({ tab: 'buy', param: null })
    expect(parseRoute('#/', 'buy')).toEqual({ tab: 'buy', param: null })
  })

  it('reads every tab, with or without the leading slash', () => {
    for (const tab of TABS) {
      expect(parseRoute(`#/${tab}`, 'home')).toEqual({ tab, param: null })
      expect(parseRoute(`${tab}`, 'home')).toEqual({ tab, param: null })
    }
    expect(parseRoute('#/home', 'buy')).toEqual({ tab: 'home', param: null })
  })

  it('an unknown tab is the fallback, not a crash', () => {
    expect(parseRoute('#/settings', 'home')).toEqual({ tab: 'home', param: null })
    expect(parseRoute('#/settings/x', 'buy')).toEqual({ tab: 'buy', param: null })
  })

  it('carries the second segment, decoded', () => {
    expect(parseRoute('#/buy/nns', 'home')).toEqual({ tab: 'buy', param: 'nns' })
    expect(parseRoute('#/pay/rico.nns', 'home')).toEqual({ tab: 'pay', param: 'rico.nns' })
    expect(parseRoute('#/buy/not%20a%20name%21', 'home')).toEqual({ tab: 'buy', param: 'not a name!' })
  })

  it('a malformed escape is no param rather than an exception', () => {
    expect(parseRoute('#/buy/%E0%A4%A', 'home')).toEqual({ tab: 'buy', param: null })
  })

  it('a trailing slash is no param', () => {
    expect(parseRoute('#/buy/', 'home')).toEqual({ tab: 'buy', param: null })
  })
})

describe('formatRoute', () => {
  it('round-trips through parseRoute', () => {
    for (const route of [
      { tab: 'buy' as const, param: 'nns' },
      { tab: 'pay' as const, param: 'rico.nns' },
      { tab: 'names' as const, param: null },
      { tab: 'market' as const, param: 'a name/with#odd chars' },
    ]) {
      expect(parseRoute(formatRoute(route), 'home')).toEqual(route)
    }
  })

  it('omits an empty param', () => {
    expect(formatRoute({ tab: 'inbox', param: null })).toBe('#/inbox')
    expect(formatRoute({ tab: 'buy', param: '' })).toBe('#/buy')
  })
})
