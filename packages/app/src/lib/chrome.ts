/**
 * Host chrome insets — how much of the WebView the *host* has already spent.
 *
 * Nimiq Pay draws its own bar over the top of a mini app's WebView, and on
 * Android the WebView runs edge-to-edge behind the system navigation bar. The
 * SDK exposes no geometry for either: `window.nimiqPay` carries a language and
 * a device-identifier request and nothing else (docs/rpc-reference.md §8), and
 * where the host consumes the window insets `env(safe-area-inset-*)` reads 0.
 * A layout that trusts `env()` alone therefore renders its masthead under Pay's
 * bar and its tab bar under the system buttons — which is what mini-app cycle I
 * reported: no Connect Wallet, no Disconnect, a tab bar behind the navigation
 * buttons.
 *
 * So the app reserves the space itself. `env()` is still read — it is right
 * wherever it is populated, and it is the only thing that knows about a notch —
 * and Pay's own bar is **added** to it, because that bar sits below the status
 * bar rather than instead of it. The bottom takes a floor instead of a sum:
 * there is one system bar down there, and a host that reports it honestly
 * reports the whole of it.
 *
 * The two constants are the only guesses in this file, which is why
 * `?chrome=<top>,<bottom>` overrides them: the right numbers are measurable on
 * a device in one reload, and a rebuild should not stand between someone
 * holding the phone and the answer.
 */

/** Pay's bar, drawn over the WebView below the status bar. */
export const PAY_BAR_HEIGHT = 48

/** Android's navigation bar, for a host that consumed the window insets. */
export const PAY_NAV_MIN = 24

export interface Insets {
  readonly top: number
  readonly bottom: number
}

const NO_INSETS: Insets = { top: 0, bottom: 0 }

/** Structural, so this module needs no SDK import to ask the question. */
interface PayHostWindow {
  readonly nimiqPay?: unknown
}

/**
 * True inside Nimiq Pay. `window.nimiqPay` is seeded synchronously before the
 * page script runs, so unlike `window.nimiq` — injected asynchronously, which
 * is why `init()` takes a timeout — this answer is available on the first
 * frame, before anything has been laid out.
 */
export function isPayHost(win: PayHostWindow | undefined = globalThis.window): boolean {
  return win?.nimiqPay != null
}

/** `?chrome=72,24` — two non-negative pixel counts, or null for anything else. */
export function parseChromeOverride(search: string): Insets | null {
  const raw = new URLSearchParams(search).get('chrome')
  if (raw === null) return null
  const parts = raw.split(',')
  if (parts.length !== 2) return null
  const top = Number(parts[0])
  const bottom = Number(parts[1])
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || top < 0 || bottom < 0) return null
  return { top, bottom }
}

/**
 * What `env(safe-area-inset-*)` resolves to right now, in CSS pixels. Read
 * rather than assumed: it is 0 in an Android WebView whose host consumed the
 * insets, and it is the notch on iOS.
 */
export function measureSafeArea(doc: Document = document): Insets {
  const view = doc.defaultView
  if (view == null || doc.body == null) return NO_INSETS
  const probe = doc.createElement('div')
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)'
  doc.body.appendChild(probe)
  const style = view.getComputedStyle(probe)
  const top = Number.parseFloat(style.paddingTop)
  const bottom = Number.parseFloat(style.paddingBottom)
  probe.remove()
  return {
    top: Number.isFinite(top) ? top : 0,
    bottom: Number.isFinite(bottom) ? bottom : 0,
  }
}

/**
 * The space the app must leave empty at each edge.
 *
 * Outside Pay — a desktop browser, or the Hub adapter's mobile web — the safe
 * area is the whole answer: there is no second bar, and reserving for one would
 * be a gap with nothing in it.
 */
export function chromeInsets(input: {
  readonly pay: boolean
  readonly safeArea: Insets
  readonly override: Insets | null
}): Insets {
  if (input.override !== null) return input.override
  if (!input.pay) return input.safeArea
  return {
    top: input.safeArea.top + PAY_BAR_HEIGHT,
    bottom: Math.max(input.safeArea.bottom, PAY_NAV_MIN),
  }
}

/**
 * What Nimiq Pay actually reports, for the one case this module cannot reason
 * its way out of: a WebView nobody can attach a console to, on someone else's
 * phone. `?diag=1` renders this on screen, so a single screenshot answers what
 * a browser never can — whether the host was detected, what `env()` resolved
 * to, and how big the viewport really is. Every value is read, none assumed.
 */
export function describeChrome(win: Window = window): Record<string, string> {
  const safeArea = measureSafeArea(win.document)
  const override = parseChromeOverride(win.location.search)
  const pay = isPayHost(win)
  const insets = chromeInsets({ pay, safeArea, override })
  const root = win.document.documentElement
  return {
    pay: pay ? 'yes' : 'no',
    lang: String((win as { nimiqPay?: { language?: unknown } }).nimiqPay?.language ?? '—'),
    'env top/bottom': `${safeArea.top} / ${safeArea.bottom}`,
    'reserved top/bottom': `${insets.top} / ${insets.bottom}`,
    override: override === null ? 'none' : `${override.top} / ${override.bottom}`,
    'inner w×h': `${win.innerWidth}×${win.innerHeight}`,
    'doc scrollHeight': String(root.scrollHeight),
    'visualViewport h': String(win.visualViewport?.height ?? '—'),
    dpr: String(win.devicePixelRatio),
    ua: win.navigator.userAgent.slice(0, 96),
  }
}

/**
 * Publish the insets as `--chrome-top` / `--chrome-bottom` on the root element,
 * where `app.css` spends them as the frame's padding. Called once at startup;
 * nothing here changes for the life of a session — Pay's bar does not resize
 * and the safe area only moves on rotation, which this app does not support
 * (portrait, one-handed).
 */
export function applyHostChrome(win: Window = window): Insets {
  const insets = chromeInsets({
    pay: isPayHost(win),
    safeArea: measureSafeArea(win.document),
    override: parseChromeOverride(win.location.search),
  })
  const root = win.document.documentElement
  root.style.setProperty('--chrome-top', `${insets.top}px`)
  root.style.setProperty('--chrome-bottom', `${insets.bottom}px`)
  if (isPayHost(win)) root.dataset['host'] = 'pay'
  return insets
}
