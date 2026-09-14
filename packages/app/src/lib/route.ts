/**
 * The app's routes: the URL hash, parsed and formatted here and nowhere else.
 *
 * `#/<tab>[/<param>]` — `#/buy/nns`, `#/pay/rico.nns`, `#/names/nns` (the
 * name handed to My names to manage), `#/market/indigo` (the listing to open),
 * `#/docs/prices` (the documentation page), `#/inbox`, `#/home`. An empty or
 * unknown hash is the caller's default, which is the landing page in both
 * hosts since 2026-09-12 — a browser and Nimiq Pay alike (`App.tsx`).
 *
 * The hash rather than the path, and no router library: the app's
 * nginx deliberately answers an unknown path with 404 so a stale script URL
 * never gets HTML back, and every independent host (the package is MIT for
 * that reason) would need the same rewrite rule for path routes. The one
 * path it does answer, `/pay/<name>`, is not a route: it is the shareable
 * form of the payment link, and the edge turns it into `#/pay/<name>` after
 * a crawler has read its card (`lib/payRequest.ts`). A hash needs
 * nothing from any server, survives a reload, gives the WebView's back button
 * something to pop, and makes a name linkable. `?diag=1` and `?chrome=`
 * live in the search string and are untouched (decisions.md, "Routes are the
 * hash, and the hash is one function pair").
 */

export type Tab = 'home' | 'buy' | 'pay' | 'names' | 'inbox' | 'market' | 'docs'
export type NavTab = Exclude<Tab, 'home' | 'docs'>

/**
 * The tab bar, in order. `home` is the landing page and `docs` the
 * documentation; neither is a tab, and both hide the bar (`App.tsx`) — they
 * are pages a browser lands on, not places to switch between.
 */
export const TABS: readonly NavTab[] = ['buy', 'pay', 'names', 'inbox', 'market']

const ALL_TABS: readonly Tab[] = ['home', 'docs', ...TABS]

export interface Route {
  readonly tab: Tab
  /** The second segment, decoded: a query for Buy/Pay, a name for My names and Market, a page slug for Docs. */
  readonly param: string | null
}

function isTab(value: string): value is Tab {
  return (ALL_TABS as readonly string[]).includes(value)
}

/** `location.hash` (with or without the `#`) → a route. Anything unparseable is the fallback. */
export function parseRoute(hash: string, fallback: Tab): Route {
  // `#/buy?ref=x`: the query is the referral's (lib/referral.ts), not the route's.
  const path = hash.replace(/^#/, '').replace(/\?.*$/, '').replace(/^\/+/, '')
  if (path === '') return { tab: fallback, param: null }
  const [head = '', ...rest] = path.split('/')
  if (!isTab(head)) return { tab: fallback, param: null }
  const raw = rest.join('/')
  if (raw === '') return { tab: head, param: null }
  try {
    const param = decodeURIComponent(raw)
    return { tab: head, param: param === '' ? null : param }
  } catch {
    return { tab: head, param: null }
  }
}

/** A route → the hash to assign, `#` included. */
export function formatRoute(route: Route): string {
  return route.param === null || route.param === '' ? `#/${route.tab}` : `#/${route.tab}/${encodeURIComponent(route.param)}`
}
