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
import { queryFaultLine, shortNameNoteLine, unreachableLine } from '../lib/wording'
import { ACQUIRE_ACTIONS, NameCard } from '../components/NameCard'
import { EmptyState, Spinner } from '../components/ui'

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

      {outcome.status === 'idle' && (
        <EmptyState title="Every name is an address" body="Look one up to see where it pays, or find a free one to register." />
      )}
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
    </div>
  )
}
