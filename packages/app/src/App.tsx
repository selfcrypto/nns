import { useEffect, useMemo, useRef, useState } from 'react'
import { appConfig, ConfigParseError } from './config'
import { applyHostChrome, describeChrome } from './lib/chrome'
import { formatRoute, parseRoute, TABS, type NavTab, type Route, type Tab } from './lib/route'
import { detectWallet, type Wallet } from './lib/wallet'
import { referralFromLocation, rememberReferral } from './lib/referral'
import { BRAND_MARK as MARK } from './lib/brand'
import { SITE_NAME } from './lib/wording'
import { IdentityBar } from './components/IdentityBar'
import { EraNotice } from './components/EraNotice'
import { MastheadLinks, MastheadMenu } from './components/MastheadNav'
import { TabIcon, type TabIconName } from './components/icons'
import { HomeScreen } from './screens/Home'
import { BuyScreen } from './screens/Buy'
import { DocsScreen } from './screens/Docs'
import { InboxScreen } from './screens/Inbox'
import { MyNamesScreen } from './screens/MyNames'
import { OffersScreen } from './screens/Offers'
import { PayScreen } from './screens/Pay'

/**
 * `buy` rather than `search`: the tab is named for the job, and the code says
 * the same thing the UI does. Discovery is Buy, management is My names — a name
 * you own is never handled from Buy (docs/app-ux.md §2).
 */
const TAB_LABEL: Record<Tab, string> = {
  home: 'Home',
  // "Buy/Search" rather than "Buy": the tab is still named for the job, but the
  // job people arrive with is looking a name up, and a tab called Buy reads as
  // a shop you have to enter before you may ask a question.
  buy: 'Buy/Search',
  pay: 'Pay',
  names: 'My Names',
  inbox: 'Inbox',
  market: 'Market',
  docs: 'Docs',
}

const TAB_ICON: Record<NavTab, TabIconName> = {
  buy: 'search',
  pay: 'pay',
  names: 'names',
  inbox: 'inbox',
  market: 'market',
}

/** The tab an empty or unparseable hash means. See `App`'s first comment. */
const DEFAULT_TAB: Tab = 'home'

/**
 * `?diag=1` — the host readout. Nimiq Pay's WebView takes no console and no
 * remote debugger, so the only way facts about it reach a developer is on the
 * screen of the person holding the phone. Rendered at the top of the content
 * area, which is inside both reserved insets, so it stays visible even when the
 * numbers around it are wrong. Absent otherwise; it costs nothing to ship.
 */
function ChromeDiagnostic({ wallet }: { wallet: Wallet | null }) {
  const facts = describeChrome(window, wallet === null ? null : wallet.identity)
  return (
    <dl className="diag">
      {Object.entries(facts).map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function configProblem(): string | null {
  try {
    const { resolvers } = appConfig()
    if (resolvers.length === 0) {
      return 'No resolver endpoints configured. Set VITE_NNS_RESOLVERS — the shipped default list is empty until a public NNS API exists.'
    }
    return null
  } catch (error) {
    return error instanceof ConfigParseError ? error.message : String(error)
  }
}

export function App() {
  // The screen is the URL hash (`lib/route.ts`): a reload and a shared link
  // land where the person was. An empty hash is the landing page, in a browser
  // and inside Nimiq Pay alike. Pay opened on Buy until 2026-09-12, on the
  // reasoning that the person there had already chosen the app; what they had
  // actually chosen was a search field, which is the wrong door for someone
  // who owns a name already and wants to configure it — and it left the docs
  // with no entry point at all inside Pay. Home is the one page that names
  // every way in, so both hosts start there.
  const [hash, setHash] = useState(() => window.location.hash)
  const route = useMemo(() => parseRoute(hash, DEFAULT_TAB), [hash])
  const tab = route.tab
  const [wallet, setWallet] = useState<Wallet | null>(null)
  /** The identity row's address list, open or closed. */
  const [identityOpen, setIdentityOpen] = useState(false)
  /** The nav menu, open or closed — a phone's form of the masthead links. */
  const [menuOpen, setMenuOpen] = useState(false)
  // Hub connects mutate the wallet's identity in place; this counter re-renders on them.
  const [, setIdentityNonce] = useState(0)
  const [isScrolled, setIsScrolled] = useState(false)
  const masthead = useRef<HTMLElement>(null)

  const problem = useMemo(configProblem, [])
  const diagnostic = useMemo(() => new URLSearchParams(window.location.search).get('diag') === '1', [])

  // A share link (`?ref=<name>`, §10.7) is remembered until a registration
  // confirms — first wins, and a bad one is dropped silently (lib/referral.ts).
  //
  // Read in a **render-phase initializer**, not in the effect that writes it.
  // The hash form (`#/buy?ref=x`) does not survive an effect: `useDebounced`
  // seeds with its initial value, so Buy's and Pay's `onQuery` fire on the
  // first commit and `replace()` below rewrites the hash through `formatRoute`,
  // which cannot emit a query — and React runs child effects before the
  // parent's, so this effect would already be reading a stripped hash. The
  // search form was never affected: a fragment-only `replaceState` leaves it
  // alone, which is why every link `shareLinkFor` has emitted still works.
  const [referral] = useState(() => referralFromLocation(window.location.search, window.location.hash))
  useEffect(() => {
    if (referral !== null) void rememberReferral(referral)
  }, [referral])

  useEffect(() => {
    const onHash = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 10)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  /**
   * The chrome's height, published as `--masthead-h` for the landing page —
   * the one screen that pulls its hero up behind the masthead. Measured, not
   * typed: the beta strip sits in the masthead now and its line wraps to one,
   * two or three rows depending on the phone, so any constant is wrong on some
   * screen, and wrong here is a visible seam above the hero.
   */
  useEffect(() => {
    const bar = masthead.current
    if (bar === null) return
    const publish = () => {
      document.documentElement.style.setProperty('--masthead-h', `${Math.round(bar.getBoundingClientRect().height)}px`)
    }
    publish()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(publish)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [problem])

  useEffect(() => {
    if (problem !== null) return
    let cancelled = false
    void detectWallet(window.localStorage, window.location.search).then((detected) => {
      if (cancelled) return
      // Second pass at the insets. `isHostedWebView` keys on a provider global
      // that Pay injects **asynchronously**, so the call in `main.tsx` — which
      // has to run before the first paint — can miss it, and did on a real
      // phone: the bottom reserve was computed as if this were a desktop
      // browser and the tab bar stayed under the navigation buttons.
      try {
        applyHostChrome(window, detected.identity.kind === 'pay')
      } catch {
        /* keep whatever the first pass decided */
      }
      setWallet(detected)
    })
    return () => {
      cancelled = true
    }
  }, [problem])

  if (problem !== null) {
    return (
      <div className="frame">
        <header className="masthead">
          <div className="masthead-row">
            <h1 className="wordmark">
              <img className="wordmark-mark" src={MARK} alt="" width="30" height="30" />
              {SITE_NAME}
            </h1>
          </div>
        </header>
        <main className="content">
          <div className="screen">
            <div className="empty">
              <p className="empty-title">Not configured</p>
              <p className="empty-body">{problem}</p>
            </div>
          </div>
        </main>
      </div>
    )
  }

  /** Go somewhere: a history entry, so back returns here. A no-op on the current route. */
  const navigate = (next: Route) => {
    const target = formatRoute(next)
    if (target === window.location.hash) return
    window.location.hash = target
  }

  /**
   * Rewrite the current entry without a `hashchange`. Two uses: a handoff a
   * screen has consumed (`#/names/nns` becomes `#/names` once My names shows
   * the name), so a reload does not replay it — the route state follows; and
   * Buy's or Pay's settled query, so a reload lands on the same card — the
   * route state is left alone there, because those screens are keyed on the
   * param and a remount per query would drop the field's focus.
   */
  const replace = (next: Route, sync: boolean) => {
    const target = formatRoute(next)
    window.history.replaceState(null, '', target)
    if (sync) setHash(target)
  }

  /** Buy → "Manage it": management lives in My names, so go there. */
  const manageName = (name: string) => navigate({ tab: 'names', param: name })

  /** Buy ("Check now.") → Market, with that offer or auction open. */
  const openMarket = (name?: string) => navigate({ tab: 'market', param: name ?? null })

  const connect =
    wallet?.connect == null
      ? null
      : () => {
          void wallet.connect?.().then(() => setIdentityNonce((value) => value + 1))
        }

  const disconnect =
    wallet?.disconnect == null || wallet.identity.addresses.length === 0
      ? null
      : () => {
          wallet.disconnect?.()
          if (tab === 'names') replace({ tab: 'names', param: null }, true)
          setIdentityOpen(false)
          setIdentityNonce((value) => value + 1)
        }

  return (
    <div className={`frame is-${tab}`}>
      {/*
        The beta strip is *inside* the masthead, not a sibling under it. The
        landing page pulls its hero up behind the chrome (`landing-page.module
        .css`), which swallowed a strip sitting between the two: invisible in a
        browser, a clipped sliver of the badge inside Nimiq Pay. Chrome the user
        must read belongs to the element that stays put and paints on top.
      */}
      <header className={`masthead ${isScrolled ? 'is-scrolled' : ''}`} ref={masthead}>
        <div className="masthead-row">
          <h1 className="wordmark">
            <button type="button" className="wordmark-btn" onClick={() => navigate({ tab: 'home', param: null })}>
              <img className="wordmark-mark" src={MARK} alt="" width="30" height="30" />
              {SITE_NAME}
            </button>
          </h1>
          <MastheadLinks />
          {/* One corner, two controls: the nav button and the wallet. Both hang
              a panel from here, so opening either closes the other — two panels
              overlapping in one corner is a bug you only ever see on a phone. */}
          <div className="masthead-corner">
            <MastheadMenu
              open={menuOpen}
              onToggle={() => {
                setIdentityOpen(false)
                setMenuOpen((open) => !open)
              }}
            />
            <IdentityBar
              placement="top"
              wallet={wallet}
              onConnect={connect}
              onDisconnect={disconnect}
              expanded={identityOpen}
              onToggle={() => {
                setMenuOpen(false)
                setIdentityOpen((open) => !open)
              }}
            />
          </div>
        </div>
        <EraNotice />
      </header>
      <main className="content">
        {diagnostic && <ChromeDiagnostic wallet={wallet} />}
        {tab === 'home' && (
          <HomeScreen
            onSearch={(query) => navigate({ tab: 'buy', param: query })}
            onOpenApp={() => navigate({ tab: 'names', param: null })}
          />
        )}
        {tab === 'buy' && (
          <BuyScreen
            key={route.param ?? ''}
            wallet={wallet}
            seed={route.param ?? ''}
            onQuery={(query) => replace({ tab: 'buy', param: query }, false)}
            onManage={manageName}
            onPay={(query) => navigate({ tab: 'pay', param: query })}
            onConnect={connect}
            onMarket={openMarket}
          />
        )}
        {tab === 'pay' && (
          <PayScreen
            key={route.param ?? ''}
            wallet={wallet}
            seed={route.param ?? ''}
            onQuery={(query) => replace({ tab: 'pay', param: query }, false)}
            onConnect={connect}
          />
        )}
        {tab === 'names' && (
          <MyNamesScreen wallet={wallet} manage={route.param} onManageHandled={() => replace({ tab: 'names', param: null }, true)} onConnect={connect} />
        )}
        {tab === 'docs' && <DocsScreen slug={route.param} />}
        {tab === 'inbox' && <InboxScreen wallet={wallet} onConnect={connect} />}
        {tab === 'market' && (
          <OffersScreen
            wallet={wallet}
            onConnect={connect}
            initialOpenName={route.param}
            onClearInitial={() => replace({ tab: 'market', param: null }, true)}
          />
        )}
      </main>
      {tab !== 'home' && tab !== 'docs' && (
        <nav className="tabbar" aria-label="Sections">
          {TABS.map((entry) => (
            <button
              key={entry}
              type="button"
              className={tab === entry ? 'tab tab-active' : 'tab'}
              aria-current={tab === entry ? 'page' : undefined}
              // The active tab is a no-op: a tap there must not clear the
              // query the screen reflected into the URL.
              onClick={() => {
                if (entry !== tab) navigate({ tab: entry, param: null })
              }}
            >
              <TabIcon name={TAB_ICON[entry]} />
              <span className="tab-label">{TAB_LABEL[entry]}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  )
}
