import { describe, expect, it } from 'vitest'
import { PAY_NAV_MIN, bottomShortfall, chromeInsets, isHostedWebView, keyboardVisible, parseChromeOverride } from './chrome'

describe('isHostedWebView', () => {
  it('answers on either global, because Pay has two containers', () => {
    // The mini-app container seeds the host context…
    expect(isHostedWebView({ nimiqPay: { language: 'de' } })).toBe(true)
    // …and the in-app browser need not, but the provider is injected there,
    // because the wallet works. Testing only the first is what made the bottom
    // reserve a no-op on a real phone (Rico, 2026-08-22).
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
  it('answers on the visual viewport shrinking past 100px under a constant layout viewport — overlay mode', () => {
    expect(keyboardVisible({ innerHeight: 803, maxInnerHeight: 803, visualHeight: 420 })).toBe(true)
    expect(keyboardVisible({ innerHeight: 803, maxInnerHeight: 803, visualHeight: 780 })).toBe(false)
  })

  it("answers on the layout viewport itself shrinking past 150px — resize mode, Pay's in-app browser", () => {
    expect(keyboardVisible({ innerHeight: 420, maxInnerHeight: 803, visualHeight: 420 })).toBe(true)
    expect(keyboardVisible({ innerHeight: 420, maxInnerHeight: 803, visualHeight: null })).toBe(true)
  })

  it('desktop focus shrinks nothing and hides nothing', () => {
    expect(keyboardVisible({ innerHeight: 900, maxInnerHeight: 900, visualHeight: 900 })).toBe(false)
    expect(keyboardVisible({ innerHeight: 900, maxInnerHeight: 900, visualHeight: null })).toBe(false)
  })
})

describe('bottomShortfall', () => {
  it('takes the visual-viewport gap — the taller-than-shown quirk', () => {
    expect(bottomShortfall({ innerHeight: 877, visualHeight: 803, svhHeight: 877 })).toBe(74)
  })

  it('takes the svh gap — the nav bar drawn over the WebView, invisible to visualViewport', () => {
    // Rico's device, 2026-08-23: visual == inner (slack 0), yet the 100svh
    // frame ends above the nav buttons. The svh probe is what sees them.
    expect(bottomShortfall({ innerHeight: 851, visualHeight: 851, svhHeight: 803 })).toBe(48)
  })

  it('takes the larger gap when both exist, and floors at 0', () => {
    expect(bottomShortfall({ innerHeight: 925, visualHeight: 851, svhHeight: 803 })).toBe(122)
    expect(bottomShortfall({ innerHeight: 803, visualHeight: 803, svhHeight: 803 })).toBe(0)
    expect(bottomShortfall({ innerHeight: 800, visualHeight: 803, svhHeight: 805 })).toBe(0)
  })

  it('is null, not 0, with nothing to measure — the caller falls back to PAY_NAV_MIN', () => {
    expect(bottomShortfall({ innerHeight: 803, visualHeight: null, svhHeight: null })).toBeNull()
  })

  it('one instrument missing does not blind the other', () => {
    expect(bottomShortfall({ innerHeight: 851, visualHeight: null, svhHeight: 803 })).toBe(48)
    expect(bottomShortfall({ innerHeight: 877, visualHeight: 803, svhHeight: null })).toBe(74)
  })
})

describe('chromeInsets with live slack', () => {
  const safeArea = { top: 0, bottom: 0 }
  it('spends the measured slack as the bottom reserve, 0 included', () => {
    expect(chromeInsets({ pay: true, safeArea, override: null, slack: 74 }).bottom).toBe(74)
    expect(chromeInsets({ pay: true, safeArea, override: null, slack: 0 }).bottom).toBe(0)
  })

  it('falls back to PAY_NAV_MIN only when there was nothing to measure', () => {
    expect(chromeInsets({ pay: true, safeArea, override: null, slack: null }).bottom).toBe(PAY_NAV_MIN)
    expect(chromeInsets({ pay: true, safeArea, override: null }).bottom).toBe(PAY_NAV_MIN)
  })
})

describe('the reserve clamp and the Android nav floor', () => {
  const safeArea = { top: 0, bottom: 0 }

  it('clamps a pathological measurement to a strip, not half a screen', () => {
    expect(bottomShortfall({ innerHeight: 2000, visualHeight: 1000, svhHeight: 1000 })).toBe(160)
  })

  it('floors the reserve under Android nav buttons no instrument can see', () => {
    // Rico's device: every instrument reads 0 while the buttons overlay the
    // bar mid-scroll — nav overlay AND layout slack, both invisible, so the
    // floor is the full screenshot-measured pair (48 + 74).
    expect(chromeInsets({ pay: true, safeArea, override: null, slack: 0, android: true }).bottom).toBe(120)
    // A measured shortfall above the floor wins.
    expect(chromeInsets({ pay: true, safeArea, override: null, slack: 140, android: true }).bottom).toBe(140)
    // No floor outside Android — iOS reports its home indicator through env().
    expect(chromeInsets({ pay: true, safeArea, override: null, slack: 0, android: false }).bottom).toBe(0)
  })
})
