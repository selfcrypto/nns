import { useEffect, useMemo, useState } from 'react'
import { appConfig, ConfigParseError } from './config'
import { detectWallet, type Wallet } from './lib/wallet'
import { connectWalletLabel, disconnectLabel } from './lib/wording'
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
type Tab = 'buy' | 'pay' | 'names' | 'inbox' | 'market'

const TABS: readonly Tab[] = ['buy', 'pay', 'names', 'inbox', 'market']

const TAB_LABEL: Record<Tab, string> = {
  // "Buy/Search" rather than "Buy": the tab is still named for the job, but the
  // job people arrive with is looking a name up, and a tab called Buy reads as
  // a shop you have to enter before you may ask a question.
  buy: 'Buy/Search',
  pay: 'Pay',
  names: 'My Names',
  inbox: 'Inbox',
  market: 'Market',
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
  const [tab, setTab] = useState<Tab>('buy')
  const [seed, setSeed] = useState('')
  /** A name Buy handed to My names to manage, cleared when My names is done with it. */
  const [manage, setManage] = useState<string | null>(null)
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
          setIdentityNonce((value) => value + 1)
        }

  return (
    <div className="frame">
      <header className="masthead">
        <h1 className="wordmark">nns</h1>
        <p className="masthead-sub">names on Nimiq</p>
        {connect !== null && wallet !== null && wallet.identity.addresses.length === 0 && (
          <button type="button" className="connect connect-top" onClick={connect}>
            {connectWalletLabel()}
          </button>
        )}
        {disconnect !== null && (
          <button type="button" className="connect connect-quiet connect-top" onClick={disconnect}>
            {disconnectLabel()}
          </button>
        )}
      </header>
      <main className="content">
        {tab === 'buy' && <BuyScreen key={seed} wallet={wallet} seed={seed} onManage={manageName} />}
        {tab === 'pay' && <PayScreen wallet={wallet} />}
        {tab === 'names' && (
          <MyNamesScreen
            wallet={wallet}
            manage={manage}
            onManageHandled={() => setManage(null)}
            onConnect={connect}
            onDisconnect={disconnect}
          />
        )}
        {tab === 'inbox' && <InboxScreen wallet={wallet} />}
        {tab === 'market' && <OffersScreen onOpen={openName} />}
      </main>
      <nav className="tabbar" aria-label="Sections">
        {TABS.map((entry) => (
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
