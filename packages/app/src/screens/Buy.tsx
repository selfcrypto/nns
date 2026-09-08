/**
 * **Buy** — the discovery screen, and the app's front door. Look a name up,
 * find a free one, register it, or bid on one that is for sale.
 *
 * It deliberately does **not** manage names. A name the viewer already owns
 * gets one line and a handoff to My names (`onManage`): acquiring and managing
 * are different jobs, and a screen called Buy offering to transfer your own name
 * away is the confusion that split them (docs/app-ux.md §2).
 */

import { useMemo, useState } from 'react'
import { isShortName, queryFault, search } from '../lib/search'
import { useAsync } from '../lib/useAsync'
import { useDebounced } from '../lib/useDebounced'
import type { Wallet } from '../lib/wallet'
import {
  queryFaultLine,
  shortNameNoteLine,
  unreachableLine,
} from '../lib/wording'
import { ACQUIRE_ACTIONS, NameCard } from '../components/NameCard'
import { Spinner } from '../components/ui'
import styles from './buysearch.module.css'


/**
 * Long enough that a word typed at speed is one query, not one per character —
 * `/api/` rate-limits nothing and every query verifies a Merkle proof — and it
 * is also what stops the hint scolding a half-typed name.
 */
const SETTLE_MS = 1_000

export function BuyScreen({
  wallet,
  seed,
  onManage,
  onPay,
  onConnect,
  onMarket,
}: {
  wallet: Wallet | null
  seed: string
  onManage: (name: string) => void
  /** Hands the query, as typed, to the Pay tab — the one action a delegated card has. */
  onPay: (query: string) => void
  onConnect?: (() => void) | null
  onMarket?: ((name?: string) => void) | null
}) {
  const [text, setText] = useState(seed)
  const [nonce, setNonce] = useState(0)
  const trimmed = text.trim().toLowerCase()
  const [query, flushQuery] = useDebounced(trimmed, SETTLE_MS)

  // Off `query`, not `text`: a hint about a string still being typed is the
  // thing that made these hints hated. At most one, and the tone means
  // something — red is "this can never be a name", grey is "this is a real
  // name, and here is the rule that governs it".
  const hint = useMemo((): { readonly tone: 'field-error' | 'note'; readonly text: string } | null => {
    const fault = queryFault(query)
    if (fault !== null) return { tone: 'field-error', text: queryFaultLine(fault) }
    // Stays up once the card lands — it is what explains a Reserved answer.
    return isShortName(query) ? { tone: 'note', text: shortNameNoteLine() } : null
  }, [query])

  const outcome = useAsync(query === '' ? null : () => search(query), [query, nonce])

  return (
    <div className={`screen buy-screen ${styles.lightThemeWrapper}`}>
      <div className={styles.heroSection}>
        <div className={styles.heroContent}>
          <div className={styles.buyHeroHeader}>
            <h1 className={styles.buyHeroTitle}>Find your name</h1>
          </div>

          <div className={styles.dashboardPanel}>
            <form
              className={styles.dashboardSearch}
              onSubmit={(event) => {
                event.preventDefault()
                // Explicit intent: don't make them wait out the settle.
                if (trimmed !== '') {
                  flushQuery()
                  setNonce((value) => value + 1)
                }
              }}
            >
              <div className={styles.searchWrapper}>
                <div className={styles.searchIcon}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8"></circle>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                  </svg>
                </div>
                <input
                  className={`nns-name ${styles.searchInput}`}
                  type="text"
                  inputMode="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="name, or label.name"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  aria-label="Search names"
                />
                <button className={styles.searchBtn} type="submit" disabled={trimmed === ''}>
                  Lookup
                </button>
              </div>
            </form>
            {hint !== null && <p className={hint.tone} style={{ textAlign: 'center', margin: '0' }}>{hint.text}</p>}

            {outcome.status === 'idle' && (
              <div className={styles.buyIdleContent}>
                <div className={styles.suggestionChips}>
                  <span className={styles.suggestionLabel}>Try:</span>
                  {['alice', 'david', 'sarah', 'james'].map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      className={styles.suggestionChip}
                      onClick={() => {
                        setText(suggestion)
                      }}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>

                <div className={styles.buyTrustLine}>
                  <div className={styles.trustItem}>
                    <svg className={styles.trustIcon} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                    </svg>
                    <span>100% On-Chain</span>
                  </div>
                  <span className={styles.trustDot}>•</span>
                  <div className={styles.trustItem}>
                    <svg className={styles.trustIcon} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                      <path d="m9 12 2 2 4-4"></path>
                    </svg>
                    <span>Self-Custody</span>
                  </div>
                  <span className={styles.trustDot}>•</span>
                  <div className={styles.trustItem}>
                    <svg className={styles.trustIcon} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                      <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                      <line x1="12" y1="22.08" x2="12" y2="12"></line>
                    </svg>
                    <span>Zero Contracts</span>
                  </div>
                </div>
              </div>
            )}
            {outcome.status === 'loading' && (
              <div style={{ padding: '20px 0' }}>
                <Spinner />
              </div>
            )}
            {outcome.status === 'error' && <p className="field-error" style={{ textAlign: 'center' }}>{unreachableLine()}</p>}
            {outcome.status === 'done' && outcome.value.kind !== 'invalid' && (
              <div style={{ width: '100%', animation: 'fadeIn 0.3s ease-in' }}>
                <NameCard
                  outcome={outcome.value}
                  wallet={wallet}
                  nowMs={Date.now()}
                  actions={ACQUIRE_ACTIONS}
                  onChanged={() => setNonce((value) => value + 1)}
                  onManage={onManage}
                  onPay={onPay}
                  onConnect={onConnect}
                  onMarket={onMarket}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

