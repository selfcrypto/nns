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
 * The bottom reserve inside Pay: **two** things, not one, which is why 48 was
 * not enough and why the tab bar kept landing under the navigation buttons
 * through three attempts.
 *
 *   - Android's navigation bar is **48dp**, drawn over the page, with
 *     `env(safe-area-inset-bottom)` reading 0 underneath it because the host
 *     consumed the window insets.
 *   - Pay's in-app browser hands the page a viewport **taller than what it
 *     shows**. Measured off a device screenshot (2026-08-22, 360 CSS px wide):
 *     the tab bar's top sat at ~781 CSS px down a screen 803 tall, with the
 *     page starting 97 px below the top of it — putting the frame's bottom
 *     edge roughly **74 px past** the visible area. That is the slack the page
 *     scrolls by, and it is why a `position: fixed` frame was *worse*: a fixed
 *     element's containing block is that taller viewport.
 *
 * 48 + 74, rounded up for margin. It is a floor, not a sum with `env()`: one
 * bar is down there, and a host that reports it honestly reports all of it.
 *
 * **Demoted to a fallback on 2026-08-23.** The predicted dead band showed up
 * the very next day — same person, next session, a 120 px blank strip with
 * the real reserve at 0 — so the reserve is now `bottomShortfall`, measured
 * live from `visualViewport` (the same 74 px component this constant baked
 * in, on the day it was 74). And re-demoted the same day, correctly this time: the visual
 * viewport cannot see an Android nav bar drawn *over* the WebView — the 48
 * component — which came back the moment the reserve was slack alone. The
 * reserve is now `bottomShortfall`, the larger of the visual-viewport gap
 * and the `100svh` gap, which does capture the overlay. This number is used
 * only where neither can be measured, and `?chrome=0,<n>` still overrides
 * everything.
 */
export const PAY_NAV_MIN = 120

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
  /** Live {@link bottomShortfall}; `null`/absent falls back to {@link PAY_NAV_MIN}. */
  readonly slack?: number | null
}): Insets {
  if (input.override !== null) return input.override
  if (!input.pay) return input.safeArea
  return {
    // **Zero, not the safe area.** Pay's WebView already begins below the
    // status bar *and* below Pay's own bar — three device screenshots show the
    // page starting clear of both — yet `env(safe-area-inset-top)` still
    // reports the status bar there. Honouring it reserved a strip of nothing
    // twice over, once as a 48 px guess and then again as the inset itself.
    top: 0,
    // The bottom reserve is the *measured* slack when the viewport can be
    // measured. The PAY_NAV_MIN constant survived one day as the answer and
    // was wrong on the next device (Kike's screenshots, 2026-08-23: a dead
    // 120 px band with the real reserve at 0) — it is now only the fallback
    // for a WebView with no visualViewport to measure.
    bottom: Math.max(input.safeArea.bottom, input.slack ?? PAY_NAV_MIN),
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
    '100svh': String(measureSmallViewport(win.document) ?? '—'),
    'screen h': String(win.screen.height),
    'doc scrollHeight': String(root.scrollHeight),
    dpr: String(win.devicePixelRatio),
    ua: win.navigator.userAgent.slice(0, 96),
  }
}

/**
 * Whether an on-screen keyboard is up. Two signatures, because WebViews
 * disagree about what a keyboard does to the page:
 *
 *   - **Overlay mode**: the layout viewport keeps its height and the *visual*
 *     one shrinks — `innerHeight - visualHeight` opens past 100 px.
 *   - **Resize mode** — what Pay's in-app browser actually does (Kike's
 *     second screenshot pair, 2026-08-23: the bar re-stuck above the
 *     keyboard, so the layout viewport itself shrank and the first detector
 *     never fired): `innerHeight` drops well below the tallest value this
 *     session has seen. 150 px is far above any browser-chrome collapse and
 *     far below any keyboard.
 *
 * Focus alone is deliberately not a signal: hardware keyboards and desktops
 * focus fields without occluding anything. A WebView with no
 * `visualViewport` still gets the resize-mode answer.
 */
export function keyboardVisible(view: {
  readonly innerHeight: number
  readonly maxInnerHeight: number
  readonly visualHeight: number | null
}): boolean {
  if (view.visualHeight !== null && view.innerHeight - view.visualHeight > 100) return true
  return view.maxInnerHeight - view.innerHeight > 150
}

/**
 * How far a `sticky; bottom: 0` element would sit below the *usable* bottom
 * of the screen — the tab bar's reserve, measured live from **two** shortfalls
 * because one of them is invisible to the other's instrument:
 *
 *   - `innerHeight − visualViewport.height`: the "viewport taller than what
 *     it shows" quirk of Pay's in-app browser.
 *   - `innerHeight − 100svh`: the Android navigation bar drawn **over** the
 *     WebView. `visualViewport` does not see an overlaid system bar — on
 *     2026-08-23 it measured 0 on a device whose nav buttons were sitting
 *     straight on the tab bar's labels (Kike's third screenshot set, the
 *     original 2026-08-22 bug back for one deploy) — but the same screenshots
 *     show the `100svh` frame ending *above* those buttons, so the svh probe
 *     is the instrument that captures it.
 *
 * The reserve is the larger shortfall, floored at 0. `null` only when
 * neither can be measured — no `visualViewport` and no `svh` support — and
 * the caller falls back to {@link PAY_NAV_MIN} rather than guessing 0.
 *
 * Only meaningful while no keyboard is up: a keyboard opens the same gaps,
 * which is why {@link watchViewport} re-measures only when
 * {@link keyboardVisible} says false.
 */
export function bottomShortfall(view: {
  readonly innerHeight: number
  readonly visualHeight: number | null
  readonly svhHeight: number | null
}): number | null {
  const gaps = [view.visualHeight, view.svhHeight]
    .filter((height): height is number => height !== null)
    .map((height) => view.innerHeight - height)
  if (gaps.length === 0) return null
  return Math.max(0, Math.round(Math.max(...gaps)))
}

/**
 * What `100svh` resolves to right now, in CSS pixels — the probe that makes
 * the nav-overlay shortfall measurable at all. `null` where the unit is
 * unsupported (a WebView old enough also predates the quirks this measures).
 */
export function measureSmallViewport(doc: Document = document): number | null {
  const view = doc.defaultView
  if (view == null || doc.body == null) return null
  if (typeof view.CSS?.supports === 'function' && !view.CSS.supports('height', '100svh')) return null
  const probe = doc.createElement('div')
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:100svh;visibility:hidden;pointer-events:none'
  doc.body.appendChild(probe)
  const height = probe.getBoundingClientRect().height
  probe.remove()
  return Number.isFinite(height) && height > 0 ? height : null
}

/**
 * Keep the root element in step with the viewport: `data-keyboard` while an
 * on-screen keyboard is up (app.css hides the tab bar — sticky resolves
 * against the resized viewport, which is how the bar ended up mid-screen
 * over the very sheet being typed into), and a re-measured
 * `--chrome-bottom` whenever it is not (the reserve is live slack, not a
 * constant). `focusin`/`focusout` are triggers only — the decision is always
 * {@link keyboardVisible}'s, with a `focusout` re-check shortly after
 * because the viewport grows back only once the event has fired.
 */
export function watchViewport(win: Window = window): void {
  const root = win.document.documentElement
  let maxInner = win.innerHeight
  const update = () => {
    const inner = win.innerHeight
    maxInner = Math.max(maxInner, inner)
    const keyboard = keyboardVisible({
      innerHeight: inner,
      maxInnerHeight: maxInner,
      visualHeight: win.visualViewport?.height ?? null,
    })
    if (keyboard) {
      root.dataset['keyboard'] = '1'
    } else {
      delete root.dataset['keyboard']
      applyHostChrome(win, root.dataset['host'] === 'pay')
    }
  }
  win.visualViewport?.addEventListener('resize', update)
  win.addEventListener('resize', update)
  win.document.addEventListener('focusin', update)
  win.document.addEventListener('focusout', () => {
    win.setTimeout(update, 80)
  })
  update()
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
    slack: bottomShortfall({
      innerHeight: win.innerHeight,
      visualHeight: win.visualViewport?.height ?? null,
      svhHeight: measureSmallViewport(win.document),
    }),
  })
  const root = win.document.documentElement
  root.style.setProperty('--chrome-top', `${insets.top}px`)
  root.style.setProperty('--chrome-bottom', `${insets.bottom}px`)
  if (pay) root.dataset['host'] = 'pay'
  return insets
}
