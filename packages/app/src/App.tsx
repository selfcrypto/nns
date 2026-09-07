import { useEffect, useMemo, useState } from 'react'
import { appConfig, ConfigParseError } from './config'
import { applyHostChrome, describeChrome, isHostedWebView } from './lib/chrome'
import { detectWallet, type Wallet } from './lib/wallet'
import { IdentityBar } from './components/IdentityBar'
import { TabIcon, type TabIconName } from './components/icons'
import { HomeScreen } from './screens/Home'
import { BuyScreen } from './screens/Buy'
import { InboxScreen } from './screens/Inbox'
import { MyNamesScreen } from './screens/MyNames'
import { OffersScreen } from './screens/Offers'
import { PayScreen } from './screens/Pay'

/**
 * `buy` rather than `search`: the tab is named for the job, and the code says
 * the same thing the UI does. Discovery is Buy, management is My names — a name
 * you own is never handled from Buy (docs/app-ux.md §2).
 */
type Tab = 'home' | 'buy' | 'pay' | 'names' | 'inbox' | 'market'
type NavTab = Exclude<Tab, 'home'>

const TABS: readonly NavTab[] = ['buy', 'pay', 'names', 'inbox', 'market']

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
}

const TAB_ICON: Record<NavTab, TabIconName> = {
  buy: 'search',
  pay: 'pay',
  names: 'names',
  inbox: 'inbox',
  market: 'market',
}

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
  // The landing page is for a browser. Inside Nimiq Pay the person already
  // chose the app, so the front door is Buy — `isHostedWebView` can miss the
  // provider before the first paint, and `detectWallet` corrects it below.
  const [tab, setTab] = useState<Tab>(() => (isHostedWebView(window) ? 'buy' : 'home'))
  const [seed, setSeed] = useState('')
  /** A name Buy handed to My names to manage, cleared when My names is done with it. */
  const [manage, setManage] = useState<string | null>(null)
  /** A query Buy handed to Pay. Keyed on the screen, so a second handoff starts a clean send. */
  const [payFor, setPayFor] = useState('')
  const [wallet, setWallet] = useState<Wallet | null>(null)
  /** The identity row's address list, open or closed. */
  const [identityOpen, setIdentityOpen] = useState(false)
  // Hub connects mutate the wallet's identity in place; this counter re-renders on them.
  const [, setIdentityNonce] = useState(0)

  const problem = useMemo(configProblem, [])
  const diagnostic = useMemo(() => new URLSearchParams(window.location.search).get('diag') === '1', [])

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
      if (detected.identity.kind === 'pay') setTab((current) => (current === 'home' ? 'buy' : current))
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
          <h1 className="wordmark">nns</h1>
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

  /** Market → a name's card, which is discovery: Buy. */
  const openName = (name: string) => {
    setSeed(name)
    setTab('buy')
  }

  /** Buy → "Manage it": management lives in My names, so go there. */
  const manageName = (name: string) => {
    setManage(name)
    setTab('names')
  }

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
          setManage(null)
          setIdentityOpen(false)
          setIdentityNonce((value) => value + 1)
        }

  const [isScrolled, setIsScrolled] = useState(false)

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 10)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  return (
    <div className={`frame ${tab === 'home' ? 'is-home' : ''}`}>
      <header className={`masthead ${isScrolled ? 'is-scrolled' : ''}`}>
        <h1 className="wordmark" onClick={() => setTab('home')} style={{ cursor: 'pointer' }}>nns</h1>
        <p className="masthead-sub">names on Nimiq</p>
        <IdentityBar
          placement="top"
          wallet={wallet}
          onConnect={connect}
          onDisconnect={disconnect}
          expanded={identityOpen}
          onToggle={() => setIdentityOpen((open) => !open)}
        />
      </header>
      <main className="content">
        {diagnostic && <ChromeDiagnostic wallet={wallet} />}
        {tab === 'home' && <HomeScreen onSearch={(q) => { setSeed(q); setTab('buy'); }} />}
        {tab === 'buy' && (
          <BuyScreen
            key={seed}
            wallet={wallet}
            seed={seed}
            onManage={manageName}
            onPay={(query) => {
              setPayFor(query)
              setTab('pay')
            }}
          />
        )}
        {tab === 'pay' && <PayScreen key={payFor} wallet={wallet} seed={payFor} />}
        {tab === 'names' && (
          <MyNamesScreen wallet={wallet} manage={manage} onManageHandled={() => setManage(null)} />
        )}
        {tab === 'inbox' && <InboxScreen wallet={wallet} />}
        {tab === 'market' && <OffersScreen onOpen={openName} />}
      </main>
      {tab !== 'home' && (
        <nav className="tabbar" aria-label="Sections">
          {TABS.map((entry) => (
            <button
              key={entry}
              type="button"
              className={tab === entry ? 'tab tab-active' : 'tab'}
              aria-current={tab === entry ? 'page' : undefined}
              onClick={() => setTab(entry)}
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
