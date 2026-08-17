/**
 * One rendering of a name, shared by **Buy** and **My names**, because the two
 * screens show the same card and must not drift into two.
 *
 * What differs between them is only which actions the card offers, and that is
 * a prop: discovery offers acquisition (`register`, `buy`), management offers
 * the owner set. Legality is not decided here — `actionGates` and `signerFor`
 * still say what is possible; this says what the screen is *for*.
 */

import { useState } from 'react'
import { CONSTANTS } from '@nns/core'
import { primaryAddress } from '../lib/identity'
import { approxDate, formatApproxDate } from '../lib/format'
import type { SearchOutcome } from '../lib/search'
import { actionGates, nameView, sameAddress, signerFor, type AppAction } from '../lib/states'
import type { Wallet } from '../lib/wallet'
import {
  ACTION_LABEL,
  GATE_REASON_TEXT,
  alarmBody,
  alarmHeadline,
  availableLine,
  delegateFailedLine,
  graceLine,
  manageOwnNameLabel,
  messageOwnerLabel,
  ownNameLine,
  parentNotDelegatingLine,
  queryFaultLine,
  reservedLine,
  unreachableLine,
} from '../lib/wording'
import { AddressRow, Overlays, TitleName, VerificationLine, WarningNotes, tierOf } from './result'
import { ActionSheet } from './ActionSheet'
import { Composer } from './Composer'
import { PinCheck } from './PinCheck'
import { RailCard } from './ui'

/** Discovery: what someone who does not own the name can do with it. */
export const ACQUIRE_ACTIONS: readonly AppAction[] = ['register', 'buy']

/** Management: the owner's six, which live in My names and nowhere else. */
export const OWNER_ACTIONS: readonly AppAction[] = ['setTarget', 'transfer', 'delegate', 'renew', 'offer', 'cancel']

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

/** True when one of the viewer's addresses owns the name the outcome carries. */
export function ownedByViewer(outcome: SearchOutcome, viewers: readonly string[]): boolean {
  const owner = outcome.kind === 'resolved' || outcome.kind === 'availability' || outcome.kind === 'grace' ? outcome.info?.record?.owner ?? null : null
  return owner !== null && viewers.some((address) => sameAddress(address, owner))
}

export function NameCard({
  outcome,
  wallet,
  nowMs,
  actions,
  onChanged,
  onManage,
}: {
  outcome: SearchOutcome
  wallet: Wallet | null
  nowMs: number
  actions: readonly AppAction[]
  onChanged: () => void
  /**
   * Buy passes this: a name the viewer already owns gets a handoff to My names
   * instead of the owner toolbox. Managing what you own is a different job from
   * acquiring something, and a discovery screen offering to transfer your name
   * is the confusion this replaces. Null in My names, which *is* the
   * destination.
   */
  onManage: ((name: string) => void) | null
}) {
  const sender = wallet === null ? null : primaryAddress(wallet.identity)
  const viewers = wallet?.identity.addresses ?? []

  switch (outcome.kind) {
    case 'invalid':
      return <p className="field-error">{queryFaultLine(outcome.fault)}</p>

    case 'resolved': {
      const name = outcome.info?.name ?? outcome.result.name
      const mine = onManage !== null && ownedByViewer(outcome, viewers)
      return (
        <RailCard tier={tierOf(outcome.result)}>
          <TitleName name={outcome.result.query} />
          <PinCheck query={outcome.result.query} address={outcome.result.address} />
          <AddressRow address={outcome.result.address} full />
          <VerificationLine result={outcome.result} />
          {outcome.info !== null && <Overlays info={outcome.info} nowMs={nowMs} />}
          <WarningNotes warnings={outcome.result.warnings} />
          {mine ? (
            <div className="own-name">
              <p className="own-name-line">{ownNameLine()}</p>
              <button type="button" className="action-go" onClick={() => onManage(name)}>
                {manageOwnNameLabel()}
              </button>
            </div>
          ) : (
            <Actions actions={actions} name={name} info={outcome.info} wallet={wallet} onChanged={onChanged} />
          )}
          {outcome.info !== null && outcome.info.record !== null && !mine && (
            <details className="message-owner">
              <summary>{messageOwnerLabel()}</summary>
              <Composer name={outcome.info.name} recipient={outcome.info.record.owner} wallet={wallet} sender={sender} />
            </details>
          )}
        </RailCard>
      )
    }

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
          <Actions actions={actions} name={outcome.name} info={outcome.info} wallet={wallet} onChanged={onChanged} />
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
      const mine = onManage !== null && ownedByViewer(outcome, viewers)
      return (
        <RailCard tier="plain">
          <TitleName name={outcome.name} />
          <p>{graceLine(until)}</p>
          {mine ? (
            <div className="own-name">
              <p className="own-name-line">{ownNameLine()}</p>
              <button type="button" className="action-go" onClick={() => onManage(outcome.name)}>
                {manageOwnNameLabel()}
              </button>
            </div>
          ) : (
            <Actions actions={actions} name={outcome.name} info={outcome.info} wallet={wallet} onChanged={onChanged} />
          )}
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
