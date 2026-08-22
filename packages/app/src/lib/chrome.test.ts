import { describe, expect, it } from 'vitest'
import { PAY_BAR_HEIGHT, PAY_NAV_MIN, chromeInsets, isPayHost, parseChromeOverride } from './chrome'

describe('isPayHost', () => {
  it('answers on the host context Pay seeds before the page script runs', () => {
    expect(isPayHost({ nimiqPay: { language: 'de' } })).toBe(true)
    expect(isPayHost({})).toBe(false)
    expect(isPayHost(undefined)).toBe(false)
  })
})

describe('parseChromeOverride', () => {
  it('reads two pixel counts', () => {
    expect(parseChromeOverride('?chrome=72,24')).toEqual({ top: 72, bottom: 24 })
    expect(parseChromeOverride('?chrome=0,0')).toEqual({ top: 0, bottom: 0 })
  })

  it('is absent, not zero, when unusable', () => {
    expect(parseChromeOverride('')).toBeNull()
    expect(parseChromeOverride('?address=NQ07')).toBeNull()
    expect(parseChromeOverride('?chrome=72')).toBeNull()
    expect(parseChromeOverride('?chrome=72,24,8')).toBeNull()
    expect(parseChromeOverride('?chrome=a,b')).toBeNull()
    // A negative inset would pull the frame *under* the bar it exists to clear.
    expect(parseChromeOverride('?chrome=-10,24')).toBeNull()
  })
})

describe('chromeInsets', () => {
  const safeArea = { top: 47, bottom: 34 }

  it('spends nothing extra outside Pay', () => {
    expect(chromeInsets({ pay: false, safeArea, override: null })).toEqual(safeArea)
    expect(chromeInsets({ pay: false, safeArea: { top: 0, bottom: 0 }, override: null })).toEqual({ top: 0, bottom: 0 })
  })

  it('adds Pay’s bar to the safe area, because it sits below the status bar', () => {
    expect(chromeInsets({ pay: true, safeArea, override: null })).toEqual({
      top: 47 + PAY_BAR_HEIGHT,
      bottom: 34,
    })
  })

  it('floors the bottom when the host consumed the window insets', () => {
    // Android edge-to-edge: env() reads 0 and the navigation buttons are still
    // there. Reserving nothing is what put the tab bar behind them.
    expect(chromeInsets({ pay: true, safeArea: { top: 0, bottom: 0 }, override: null })).toEqual({
      top: PAY_BAR_HEIGHT,
      bottom: PAY_NAV_MIN,
    })
  })

  it('lets the override win, so the numbers are measurable on a device', () => {
    expect(chromeInsets({ pay: true, safeArea, override: { top: 90, bottom: 12 } })).toEqual({ top: 90, bottom: 12 })
    expect(chromeInsets({ pay: false, safeArea, override: { top: 0, bottom: 0 } })).toEqual({ top: 0, bottom: 0 })
  })
})
