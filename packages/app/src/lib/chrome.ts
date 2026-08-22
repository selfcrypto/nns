/**
 * Host chrome insets — how much of the WebView the *host* has already spent.
 *
 * Every number here was **measured from a device screenshot** on 2026-08-22,
 * because Nimiq Pay's WebView takes no console and no remote debugger and no
 * browser reproduces it. Two rounds of reasoning about it from a desktop got
 * both ends wrong, in opposite directions. What the screenshots show:
 *
 *   - **Pay's browser bar does not overlay the page.** The close button, the
 *     hostname and the reload arrows sit *above* the WebView; the page begins
 *     underneath them, already clear. Reserving room for that bar bought one
 *     thing — a grey band between it and the masthead. So the top is the safe
 *     area and nothing else: right on a notch, zero where the host has already
 *     done the insetting.
 *   - **The bottom is where the space actually goes.** The Android navigation
 *     buttons are drawn straight over the tab bar's labels, and
 *     `env(safe-area-inset-bottom)` reads 0 underneath them. That one the app
 *     has to reserve itself.
 *
 * `?diag=1` renders what the host reports, and `?chrome=<top>,<bottom>`
 * overrides both reserves — so settling a number is a reload rather than a
 * rebuild, which is what it takes when the only instrument is a person holding
 * a phone.
 */

/**
 * Android's navigation bar is 48dp, and the host consumes the window insets, so
 * `env(safe-area-inset-bottom)` cannot say so. A floor, not a sum: there is one
 * bar down there, and a host that reports it honestly reports all of it.
 */
export const PAY_NAV_MIN = 48

export interface Insets {
  readonly top: number
  readonly bottom: number
}

const NO_INSETS: Insets = { top: 0, bottom: 0 }

/** Structural, so this module needs no SDK import to ask the question. */
interface HostWindow {
  readonly nimiqPay?: unknown
  readonly nimiq?: unknown
}

/**
 * True inside a Nimiq Pay WebView — **either** container.
 *
 * Two globals, and testing only the first is what made the bottom reserve a
 * no-op on a real phone. `window.nimiqPay` is the *host context*, seeded
 * synchronously for a mini app launched through `nimiqpay://miniapp?url=…`.
 * Pay's **in-app browser** is a different container: it shows browser chrome
 * (close, hostname, reload) and need not seed that context at all — but the
 * wallet works there, so `window.nimiq`, the injected provider, is present.
 *
 * The provider arrives **asynchronously** (which is why `init()` takes a
 * timeout), so a call during module init can miss it and a later one will not.
 * `applyHostChrome` therefore runs twice: once before the first paint, and
 * again once `detectWallet` has an answer.
 */
export function isHostedWebView(win: HostWindow | undefined = globalThis.window): boolean {
  return win?.nimiqPay != null || win?.nimiq != null
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
  // The top is the safe area unchanged — Pay's bar is above the WebView, not
  // over it, so there is nothing up there `env()` does not already know.
  return {
    top: input.safeArea.top,
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
export function describeChrome(
  win: Window = window,
  wallet: { readonly kind: string; readonly addresses: readonly string[] } | null = null,
): Record<string, string> {
  const safeArea = measureSafeArea(win.document)
  const override = parseChromeOverride(win.location.search)
  const pay = isHostedWebView(win)
  const insets = chromeInsets({ pay, safeArea, override })
  const root = win.document.documentElement
  const globals = win as HostWindow
  return {
    hosted: pay ? 'yes' : 'no',
    // Which of the two globals is actually there. The pair distinguishes the
    // mini-app container from the in-app browser, and either from a plain
    // mobile browser — the question `isHostedWebView` used to get wrong.
    'nimiq / nimiqPay': `${globals.nimiq != null ? 'yes' : 'no'} / ${globals.nimiqPay != null ? 'yes' : 'no'}`,
    // Which adapter won, and whether it knows any address. Together these say
    // whether a missing Disconnect is the Pay path having nothing to
    // disconnect from, or a Hub connect that never persisted.
    wallet: wallet === null ? 'detecting…' : `${wallet.kind} · ${wallet.addresses.length} address(es)`,
    lang: String((win as { nimiqPay?: { language?: unknown } }).nimiqPay?.language ?? '—'),
    'env top/bottom': `${safeArea.top} / ${safeArea.bottom}`,
    'reserved top/bottom': `${insets.top} / ${insets.bottom}`,
    override: override === null ? 'none' : `${override.top} / ${override.bottom}`,
    'inner w×h': `${win.innerWidth}×${win.innerHeight}`,
    // The three heights that disagree when a WebView is taller than what it
    // shows — which is the shape of the tab bar falling off the bottom.
    'client h': String(root.clientHeight),
    'visual h/off': `${win.visualViewport?.height ?? '—'} / ${win.visualViewport?.offsetTop ?? '—'}`,
    'screen h': String(win.screen.height),
    'doc scrollHeight': String(root.scrollHeight),
    dpr: String(win.devicePixelRatio),
    ua: win.navigator.userAgent.slice(0, 96),
  }
}

/**
 * Publish the insets as `--chrome-top` / `--chrome-bottom` on the root element,
 * where `app.css` spends them as the frame's padding.
 *
 * Called **twice**: once before the first paint, and again once `detectWallet`
 * has an answer — `hosted` carries that answer, because the provider global
 * this keys on is injected asynchronously and the first call can miss it.
 * Idempotent: two custom properties and one attribute, set to the same values
 * whenever the inputs have not changed.
 */
export function applyHostChrome(win: Window = window, hosted = false): Insets {
  const pay = hosted || isHostedWebView(win)
  const insets = chromeInsets({
    pay,
    safeArea: measureSafeArea(win.document),
    override: parseChromeOverride(win.location.search),
  })
  const root = win.document.documentElement
  root.style.setProperty('--chrome-top', `${insets.top}px`)
  root.style.setProperty('--chrome-bottom', `${insets.bottom}px`)
  if (pay) root.dataset['host'] = 'pay'
  return insets
}
