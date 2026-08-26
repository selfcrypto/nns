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
import { getBurn } from '../lib/api'
import { lunaToNim } from '../lib/format'
import { apiBase } from '../lib/nns'
import { isShortName, queryFault, search } from '../lib/search'
import { useAsync } from '../lib/useAsync'
import { useDebounced } from '../lib/useDebounced'
import type { Wallet } from '../lib/wallet'
import {
  burnBurnedLabel,
  burnEvenLine,
  burnExplainer,
  burnOwedLabel,
  burnShortfallLine,
  burnSurplusLine,
  burnTitle,
  buyEmptyBody,
  buyEmptyTitle,
  queryFaultLine,
  shortNameNoteLine,
  unreachableLine,
} from '../lib/wording'
import { ACQUIRE_ACTIONS, NameCard } from '../components/NameCard'
import { EmptyState, Spinner } from '../components/ui'

/**
 * §10.2's burn record, both halves — burned means nothing without owed
 * (packages/app/CLAUDE.md, "Show the burned quantities"). At the bottom of the
 * front door until the visual pass finds it a home; quiet when the API does
 * not answer, because an unreachable record must not read as a broken promise.
 */
function BurnFigures() {
  const burn = useAsync(() => getBurn(apiBase()), [])
  if (burn.status !== 'done') return null
  const { burned, owed } = burn.value
  const gap = owed - burned
  return (
    <section className="burn-figures">
      <h3 className="burn-title">{burnTitle()}</h3>
      <p className="burn-row">
        <span>{burnBurnedLabel()}</span>
        <span className="burn-amount">{lunaToNim(burned)} NIM</span>
      </p>
      <p className="burn-row">
        <span>{burnOwedLabel()}</span>
        <span className="burn-amount">{lunaToNim(owed)} NIM</span>
      </p>
      <p className="burn-row">{gap > 0n ? burnShortfallLine(lunaToNim(gap)) : gap < 0n ? burnSurplusLine(lunaToNim(-gap)) : burnEvenLine()}</p>
      <p className="note note-info">{burnExplainer()}</p>
    </section>
  )
}

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
}: {
  wallet: Wallet | null
  seed: string
  onManage: (name: string) => void
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
    <div className="screen">
      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault()
          // Explicit intent: don't make them wait out the settle.
          if (trimmed !== '') {
            flushQuery()
            setNonce((value) => value + 1)
          }
        }}
      >
        <input
          className="search-input nns-name"
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
        <button className="search-go" type="submit" disabled={trimmed === ''}>
          Lookup
        </button>
      </form>
      {hint !== null && <p className={hint.tone}>{hint.text}</p>}

      {outcome.status === 'idle' && <EmptyState title={buyEmptyTitle()} body={buyEmptyBody()} />}
      {outcome.status === 'loading' && <Spinner />}
      {outcome.status === 'error' && <p className="field-error">{unreachableLine()}</p>}
      {outcome.status === 'done' && (
        <NameCard
          outcome={outcome.value}
          wallet={wallet}
          nowMs={Date.now()}
          actions={ACQUIRE_ACTIONS}
          onChanged={() => setNonce((value) => value + 1)}
          onManage={onManage}
        />
      )}
      <BurnFigures />
    </div>
  )
}
