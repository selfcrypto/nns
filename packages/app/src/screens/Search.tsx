import { useMemo, useState } from 'react'
import { CONSTANTS } from '@nns/core'
import { primaryAddress } from '../lib/identity'
import { formatApproxDate, approxDate } from '../lib/format'
import { isShortName, queryFault, search, type SearchOutcome } from '../lib/search'
import { actionGates, nameView, signerFor, type AppAction } from '../lib/states'
import { useAsync } from '../lib/useAsync'
import { useDebounced } from '../lib/useDebounced'
import type { Wallet } from '../lib/wallet'
import {
  ACTION_LABEL,
  GATE_REASON_TEXT,
  alarmBody,
  alarmHeadline,
  availableLine,
  delegateFailedLine,
  graceLine,
  messageOwnerLabel,
  parentNotDelegatingLine,
  queryFaultLine,
  reservedLine,
  shortNameNoteLine,
  unreachableLine,
} from '../lib/wording'
import { AddressRow, Overlays, TitleName, VerificationLine, WarningNotes, tierOf } from '../components/result'
import { ActionSheet } from '../components/ActionSheet'
import { Composer } from '../components/Composer'
import { PinCheck } from '../components/PinCheck'
import { EmptyState, RailCard, Spinner } from '../components/ui'

const DETAIL_ACTIONS: readonly AppAction[] = ['setTarget', 'transfer', 'delegate', 'renew', 'offer', 'cancel', 'buy']

function Actions({
  actions,
  name,
  info,
  wallet,
  onChanged,
}: {
  actions: readonly AppAction[]
  name: string
  info: ReturnType<typeof nameView>['info']
  wallet: Wallet | null
  onChanged: () => void
}) {
  const [open, setOpen] = useState<AppAction | null>(null)
  const viewers = wallet?.identity.addresses ?? []
  const view = nameView(name, info)
  const gates = actionGates({ view, viewers, head: info?.height ?? 0 })

  return (
    <div className="actions">
      {actions.map((action) => {
        const gate = gates[action]
        if ((action === 'buy' && gate.reason === 'no-offer') || (action === 'register' && !gate.enabled)) return null
        const signer = signerFor(action, view, viewers)
        const usable = gate.enabled && signer !== null && wallet !== null
        return (
          <div key={action} className="action-row">
            <span className="action-label">{ACTION_LABEL[action]}</span>
            {usable ? (
              <button type="button" className="action-go" onClick={() => setOpen(open === action ? null : action)}>
                {open === action ? 'Close' : 'Open'}
              </button>
            ) : (
              <span className="action-state">{gate.reason !== null ? GATE_REASON_TEXT[gate.reason] : GATE_REASON_TEXT['no-viewer']}</span>
            )}
          </div>
        )
      })}
      {open !== null && wallet !== null && (
        <ActionSheet
          action={open}
          name={name}
          info={info}
          signer={signerFor(open, view, viewers) ?? ''}
          wallet={wallet}
          onClose={() => setOpen(null)}
          onChanged={onChanged}
        />
      )}
    </div>
  )
}

function Outcome({
  outcome,
  wallet,
  nowMs,
  onChanged,
}: {
  outcome: SearchOutcome
  wallet: Wallet | null
  nowMs: number
  onChanged: () => void
}) {
  const sender = wallet === null ? null : primaryAddress(wallet.identity)

  switch (outcome.kind) {
    case 'invalid':
      return <p className="field-error">{queryFaultLine(outcome.fault)}</p>

    case 'resolved':
      return (
        <RailCard tier={tierOf(outcome.result)}>
          <TitleName name={outcome.result.query} />
          <PinCheck query={outcome.result.query} address={outcome.result.address} />
          <AddressRow address={outcome.result.address} full />
          <VerificationLine result={outcome.result} />
          {outcome.info !== null && <Overlays info={outcome.info} nowMs={nowMs} />}
          <WarningNotes warnings={outcome.result.warnings} />
          <Actions actions={DETAIL_ACTIONS} name={outcome.info?.name ?? outcome.result.name} info={outcome.info} wallet={wallet} onChanged={onChanged} />
          {outcome.info !== null && outcome.info.record !== null && (
            <details className="message-owner">
              <summary>{messageOwnerLabel()}</summary>
              <Composer name={outcome.info.name} recipient={outcome.info.record.owner} wallet={wallet} sender={sender} />
            </details>
          )}
        </RailCard>
      )

    case 'availability': {
      const { availability } = outcome
      if (!availability.available) {
        if (availability.reason === 'RESERVED') {
          return (
            <RailCard tier="plain">
              <TitleName name={outcome.name} />
              <p>{reservedLine()}</p>
            </RailCard>
          )
        }
        return (
          <RailCard tier="plain">
            <TitleName name={outcome.name} />
            <p>Just registered by someone — search again to see it.</p>
          </RailCard>
        )
      }
      return (
        <RailCard tier={availability.verification === 'PROVEN' ? 'proven' : 'depth'}>
          <TitleName name={outcome.name} />
          <p className="available-line">{availableLine()}</p>
          <WarningNotes warnings={availability.warnings} />
          <Actions actions={['register']} name={outcome.name} info={outcome.info} wallet={wallet} onChanged={onChanged} />
        </RailCard>
      )
    }

    case 'grace': {
      const record = outcome.info?.record ?? null
      const height = outcome.info?.height ?? null
      const until =
        record !== null && height !== null
          ? formatApproxDate(approxDate(record.expiry + CONSTANTS.GRACE_PERIOD, height, nowMs))
          : 'its grace period ends'
      return (
        <RailCard tier="plain">
          <TitleName name={outcome.name} />
          <p>{graceLine(until)}</p>
          <Actions actions={['renew']} name={outcome.name} info={outcome.info} wallet={wallet} onChanged={onChanged} />
        </RailCard>
      )
    }

    case 'parent-state':
      return (
        <RailCard tier="plain">
          <TitleName name={outcome.parent} />
          <p>
            {outcome.code === 'NOT_FOUND'
              ? `${outcome.parent} isn’t registered, so nothing can answer for its subdomains.`
              : graceLine('its grace period ends')}
          </p>
        </RailCard>
      )

    case 'delegate-failed':
      return (
        <div className="stack">
          <RailCard tier="plain">
            <TitleName name={outcome.query} />
            <p>
              {outcome.code === 'PARENT_NOT_DELEGATING'
                ? parentNotDelegatingLine(outcome.parent?.name ?? outcome.query.split('.')[1] ?? '')
                : delegateFailedLine(outcome.parent?.name ?? outcome.query.split('.')[1] ?? '')}
            </p>
          </RailCard>
          {outcome.parent !== null && (
            <RailCard tier={tierOf(outcome.parent)}>
              <TitleName name={outcome.parent.name} />
              <AddressRow address={outcome.parent.address} full />
              <VerificationLine result={outcome.parent} />
            </RailCard>
          )}
        </div>
      )

    case 'alarm':
      return (
        <RailCard tier="alarm">
          <h2 className="alarm-title">{alarmHeadline()}</h2>
          <p>{alarmBody(outcome.code)}</p>
          <p className="note note-info">{outcome.message}</p>
        </RailCard>
      )

    case 'unreachable':
      return (
        <RailCard tier="plain">
          <p>{unreachableLine()}</p>
        </RailCard>
      )
  }
}

/**
 * Long enough that a word typed at speed is one query, not one per character —
 * `/api/` rate-limits nothing and every query verifies a Merkle proof — and it
 * is also what stops the hint scolding a half-typed name.
 */
const SETTLE_MS = 1_000

export function SearchScreen({ wallet, seed }: { wallet: Wallet | null; seed: string }) {
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
        <Outcome outcome={outcome.value} wallet={wallet} nowMs={Date.now()} onChanged={() => setNonce((value) => value + 1)} />
      )}
    </div>
  )
}
