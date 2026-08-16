import { useEffect, useMemo, useState } from 'react'
import { appConfig, ConfigParseError } from './config'
import { connectWallet, devAddressOverride } from './lib/sdk'
import { MyNamesScreen } from './screens/MyNames'
import { OffersScreen } from './screens/Offers'
import { SearchScreen } from './screens/Search'

type Tab = 'search' | 'names' | 'market'

const TAB_LABEL: Record<Tab, string> = { search: 'Search', names: 'My names', market: 'Market' }

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
  const [viewer, setViewer] = useState<string | null>(null)

  const problem = useMemo(configProblem, [])

  useEffect(() => {
    if (problem !== null) return
    const override = devAddressOverride(window.location.search)
    if (override !== null) {
      setViewer(override)
      return
    }
    let cancelled = false
    void connectWallet().then((session) => {
      if (!cancelled && session !== null) setViewer(session.address)
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

  return (
    <div className="frame">
      <header className="masthead">
        <h1 className="wordmark">nns</h1>
        <p className="masthead-sub">names on Nimiq</p>
      </header>
      <main className="content">
        {tab === 'search' && <SearchScreen key={seed} viewer={viewer} seed={seed} />}
        {tab === 'names' && <MyNamesScreen viewer={viewer} onOpen={openName} />}
        {tab === 'market' && <OffersScreen onOpen={openName} />}
      </main>
      <nav className="tabbar" aria-label="Sections">
        {(['search', 'names', 'market'] as const).map((entry) => (
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
