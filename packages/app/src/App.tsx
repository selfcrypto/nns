import { useEffect, useMemo, useState } from 'react'
import { appConfig, ConfigParseError } from './config'
import { detectWallet, type Wallet } from './lib/wallet'
import { connectHubLabel } from './lib/wording'
import { InboxScreen } from './screens/Inbox'
import { MyNamesScreen } from './screens/MyNames'
import { OffersScreen } from './screens/Offers'
import { SearchScreen } from './screens/Search'

type Tab = 'search' | 'names' | 'inbox' | 'market'

const TAB_LABEL: Record<Tab, string> = { search: 'Search', names: 'My names', inbox: 'Inbox', market: 'Market' }

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
  const [tab, setTab] = useState<Tab>('search')
  const [seed, setSeed] = useState('')
  const [wallet, setWallet] = useState<Wallet | null>(null)
  // Hub connects mutate the wallet's identity in place; this counter re-renders on them.
  const [, setIdentityNonce] = useState(0)

  const problem = useMemo(configProblem, [])

  useEffect(() => {
    if (problem !== null) return
    let cancelled = false
    void detectWallet(window.localStorage, window.location.search).then((detected) => {
      if (!cancelled) setWallet(detected)
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

  const openName = (name: string) => {
    setSeed(name)
    setTab('search')
  }

  const connect =
    wallet?.connect == null
      ? null
      : () => {
          void wallet.connect?.().then(() => setIdentityNonce((value) => value + 1))
        }

  return (
    <div className="frame">
      <header className="masthead">
        <h1 className="wordmark">nns</h1>
        <p className="masthead-sub">names on Nimiq</p>
        {connect !== null && wallet !== null && wallet.identity.addresses.length === 0 && (
          <button type="button" className="connect connect-top" onClick={connect}>
            {connectHubLabel()}
          </button>
        )}
      </header>
      <main className="content">
        {tab === 'search' && <SearchScreen key={seed} wallet={wallet} seed={seed} />}
        {tab === 'names' && <MyNamesScreen wallet={wallet} onOpen={openName} onConnect={connect} />}
        {tab === 'inbox' && <InboxScreen wallet={wallet} />}
        {tab === 'market' && <OffersScreen onOpen={openName} />}
      </main>
      <nav className="tabbar" aria-label="Sections">
        {(['search', 'names', 'inbox', 'market'] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            className={tab === entry ? 'tab tab-active' : 'tab'}
            onClick={() => setTab(entry)}
          >
            {TAB_LABEL[entry]}
          </button>
        ))}
      </nav>
    </div>
  )
}
