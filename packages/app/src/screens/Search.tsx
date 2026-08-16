import { useMemo, useState } from 'react'
import { CONSTANTS, parseQuery } from '@nns/core'
import { getParams } from '../lib/api'
import { formatApproxDate, approxDate, lunaToNim } from '../lib/format'
import { apiBase } from '../lib/nns'
import { search, type SearchOutcome } from '../lib/search'
import { actionGates, nameView, registrationFee, sameAddress, type AppAction } from '../lib/states'
import { useAsync } from '../lib/useAsync'
import {
  GATE_REASON_TEXT,
  alarmBody,
  alarmHeadline,
  availableLine,
  delegateFailedLine,
  graceLine,
  invalidQueryLine,
  parentNotDelegatingLine,
  reservedLine,
  sendsDisabledLine,
  unreachableLine,
  messageOwnerLabel,
} from '../lib/wording'
import { AddressRow, FeeChangeNote, Overlays, TitleName, VerificationLine, WarningNotes, tierOf } from '../components/result'
import { Composer } from '../components/Composer'
import { PinCheck } from '../components/PinCheck'
import { EmptyState, RailCard, Spinner } from '../components/ui'

const ACTION_LABEL: Record<AppAction, string> = {
  register: 'Register',
  setTarget: 'Change where it points',
  transfer: 'Transfer ownership',
  delegate: 'Set subdomain resolver',
  cancel: 'Cancel what’s pending',
  renew: 'Renew',
  offer: 'Put up for sale',
  buy: 'Buy',
}

const DETAIL_ACTIONS: readonly AppAction[] = ['setTarget', 'transfer', 'delegate', 'renew', 'offer', 'cancel', 'buy']

function ActionList({ outcome, viewer }: { outcome: SearchOutcome & { kind: 'resolved' }; viewer: string | null }) {
  const info = outcome.info
  if (info?.record === null || info === null) return null
  const view = nameView(info.name, info)
  const gates = actionGates({ view, viewer, head: info.height })
  return (
    <div className="actions">
      {DETAIL_ACTIONS.map((action) => {
        const gate = gates[action]
        if (action === 'buy' && gate.reason === 'no-offer') return null
        return (
          <div key={action} className="action-row" aria-disabled>
            <span className="action-label">{ACTION_LABEL[action]}</span>
            <span className="action-state">
              {gate.enabled ? sendsDisabledLine() : gate.reason !== null ? GATE_REASON_TEXT[gate.reason] : ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function Outcome({ outcome, viewer, nowMs }: { outcome: SearchOutcome; viewer: string | null; nowMs: number }) {
  switch (outcome.kind) {
    case 'invalid':
      return <p className="field-error">{invalidQueryLine(outcome.reason, outcome.detail)}</p>

    case 'resolved':
      return (
        <RailCard tier={tierOf(outcome.result)}>
          <TitleName name={outcome.result.query} />
          <PinCheck query={outcome.result.query} address={outcome.result.address} />
          <AddressRow address={outcome.result.address} full />
          <VerificationLine result={outcome.result} />
          {outcome.info !== null && <Overlays info={outcome.info} nowMs={nowMs} />}
          <WarningNotes warnings={outcome.result.warnings} />
          <ActionList outcome={outcome} viewer={viewer} />
          {outcome.info !== null && outcome.info.record !== null && (
            <details className="message-owner">
              <summary>{messageOwnerLabel()}</summary>
              <Composer
                name={outcome.info.name}
                ownName={viewer !== null && sameAddress(outcome.info.record.owner, viewer)}
              />
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
          <RegistrationFee name={outcome.name} nowMs={nowMs} />
          <WarningNotes warnings={availability.warnings} />
          <div className="actions">
            <div className="action-row" aria-disabled>
              <span className="action-label">{ACTION_LABEL.register}</span>
              <span className="action-state">{sendsDisabledLine()}</span>
            </div>
          </div>
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

/** The exact §10.5 value a `G` must carry, plus any scheduled change (§1 overlays). */
function RegistrationFee({ name, nowMs }: { name: string; nowMs: number }) {
  const params = useAsync(() => getParams(apiBase()), [])
  if (params.status !== 'done') return null
  return (
    <>
      <p className="fee-line">
        Registration: <strong>{lunaToNim(registrationFee(name, params.value))} NIM</strong> for a year
      </p>
      {params.value.pendingGovernance !== null && (
        <FeeChangeNote
          effectiveHeight={params.value.pendingGovernance.effectiveHeight}
          head={params.value.height}
          nowMs={nowMs}
        />
      )}
    </>
  )
}

export function SearchScreen({ viewer, seed }: { viewer: string | null; seed: string }) {
  const [text, setText] = useState(seed)
  const [submitted, setSubmitted] = useState<string | null>(seed === '' ? null : seed)

  const fieldError = useMemo(() => {
    const trimmed = text.trim().toLowerCase()
    if (trimmed === '' || trimmed === submitted) return null
    const parsed = parseQuery(trimmed)
    return parsed.ok ? null : invalidQueryLine(parsed.reason, parsed.detail)
  }, [text, submitted])

  const outcome = useAsync(submitted === null ? null : () => search(submitted), [submitted])

  return (
    <div className="screen">
      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault()
          const trimmed = text.trim().toLowerCase()
          if (trimmed !== '') setSubmitted(trimmed)
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
        <button className="search-go" type="submit" disabled={text.trim() === ''}>
          Look up
        </button>
      </form>
      {fieldError !== null && <p className="field-error">{fieldError}</p>}

      {outcome.status === 'idle' && (
        <EmptyState title="Every name is an address" body="Look one up to see where it pays, or find a free one to register." />
      )}
      {outcome.status === 'loading' && <Spinner />}
      {outcome.status === 'error' && <p className="field-error">{unreachableLine()}</p>}
      {outcome.status === 'done' && <Outcome outcome={outcome.value} viewer={viewer} nowMs={Date.now()} />}
    </div>
  )
}
