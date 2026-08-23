import { describe, expect, it } from 'vitest'
import { PAY_NAV_MIN, chromeInsets, isHostedWebView, keyboardVisible, parseChromeOverride } from './chrome'

describe('isHostedWebView', () => {
  it('answers on either global, because Pay has two containers', () => {
    // The mini-app container seeds the host context…
    expect(isHostedWebView({ nimiqPay: { language: 'de' } })).toBe(true)
    // …and the in-app browser need not, but the provider is injected there,
    // because the wallet works. Testing only the first is what made the bottom
    // reserve a no-op on a real phone (Kike, 2026-08-22).
    expect(isHostedWebView({ nimiq: {} })).toBe(true)
    expect(isHostedWebView({ nimiq: {}, nimiqPay: {} })).toBe(true)
  })

  it('is false in a plain browser', () => {
    expect(isHostedWebView({})).toBe(false)
    expect(isHostedWebView(undefined)).toBe(false)
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

  it('reserves nothing at the top — Pay has already done the insetting', () => {
    // Three device screenshots: the page begins below the status bar *and*
    // below Pay's own bar, already clear of both, while `env()` still reports
    // the status bar. Honouring it is a strip of nothing.
    expect(chromeInsets({ pay: true, safeArea, override: null })).toEqual({ top: 0, bottom: PAY_NAV_MIN })
  })

  it('floors the bottom when the host consumed the window insets', () => {
    // Android edge-to-edge: env() reads 0 and the navigation buttons are drawn
    // straight over the tab bar's labels.
    expect(chromeInsets({ pay: true, safeArea: { top: 0, bottom: 0 }, override: null })).toEqual({
      top: 0,
      bottom: PAY_NAV_MIN,
    })
  })

  it('never shrinks a bottom the host did report', () => {
    expect(chromeInsets({ pay: true, safeArea: { top: 47, bottom: 999 }, override: null }).bottom).toBe(999)
  })

  it('lets the override win, so the numbers are measurable on a device', () => {
    expect(chromeInsets({ pay: true, safeArea, override: { top: 90, bottom: 12 } })).toEqual({ top: 90, bottom: 12 })
    expect(chromeInsets({ pay: false, safeArea, override: { top: 0, bottom: 0 } })).toEqual({ top: 0, bottom: 0 })
  })
})

describe('keyboardVisible', () => {
  it('answers on the visual viewport shrinking past 100px — an on-screen keyboard, nothing else', () => {
    expect(keyboardVisible({ innerHeight: 803, visualViewport: { height: 420 } })).toBe(true)
    expect(keyboardVisible({ innerHeight: 803, visualViewport: { height: 780 } })).toBe(false)
  })

  it('is false with no visualViewport at all — degrade to keeping the bar, never guess', () => {
    expect(keyboardVisible({ innerHeight: 803 })).toBe(false)
    expect(keyboardVisible({ innerHeight: 803, visualViewport: null })).toBe(false)
  })

  it('desktop focus shrinks nothing and hides nothing', () => {
    expect(keyboardVisible({ innerHeight: 900, visualViewport: { height: 900 } })).toBe(false)
  })
})
