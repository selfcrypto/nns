/**
 * One rendering of a name, shared by **Buy** and **My names**, because the two
 * screens show the same card and must not drift into two.
 *
 * What differs between them is only which actions the card offers, and that is
 * a prop: discovery offers acquisition (`register`, `buy`), management offers
 * the owner set. Legality is not decided here — `actionGates` and `signerFor`
 * still say what is possible; this says what the screen is *for*.
 */

import { Fragment, useState } from 'react'
import { CONSTANTS } from '@nns/core'
import { primaryAddress } from '../lib/identity'
import { approxDate, formatApproxDate } from '../lib/format'
import type { SearchOutcome } from '../lib/search'
import { actionGates, renewalUrgency, sameAddress, signerFor, viewFor, type AppAction, type NameView } from '../lib/states'
import type { Wallet } from '../lib/wallet'
import {
  ACTION_LABEL,
  GATE_REASON_TEXT,
  alarmBody,
  alarmHeadline,
  availableLine,
  delegateFailedLine,
  expiresLine,
  graceEndsUnknownPhrase,
  graceLine,
  justRegisteredLine,
  manageOwnNameLabel,
  messageOwnerLabel,
  messageSubdomainLabel,
  messageSubdomainNote,
  ownNameLine,
  parentNotDelegatingLine,
  parentNotRegisteredLine,
  payThisLabel,
  queryFaultLine,
  renewDueLine,
  reservedLine,
  subdomainNotRegistrableLine,
  unreachableLine,
} from '../lib/wording'
import { AddressRow, Overlays, TitleName, VerificationLine, WarningNotes, tierOf } from './result'
import { ActionSheet } from './ActionSheet'
import { Composer } from './Composer'
import { PinCheck } from './PinCheck'
import { Badge, RailCard } from './ui'

/** Discovery: what someone who does not own the name can do with it. `buy` and `bid` never both show — state decides (§6 `A`). */
export const ACQUIRE_ACTIONS: readonly AppAction[] = ['register', 'buy', 'bid']

/** Management: the owner's eight, which live in My names and nowhere else. */
export const OWNER_ACTIONS: readonly AppAction[] = ['setTarget', 'setEvm', 'transfer', 'delegate', 'renew', 'offer', 'auction', 'cancel']

function Actions({
  actions,
  view,
  wallet,
  onChanged,
}: {
  actions: readonly AppAction[]
  /**
   * Built by the caller, because only the caller knows what the resolver said:
   * `nameView`'s unknown-state fallback is not guessable from here (states.ts).
   */
  view: NameView
  wallet: Wallet | null
  onChanged: () => void
}) {
  const [open, setOpen] = useState<AppAction | null>(null)
  const { name, info } = view
  const viewers = wallet?.identity.addresses ?? []
  const gates = actionGates({ view, viewers, head: info?.height ?? 0 })

  return (
    <div className="actions">
      {actions.map((action) => {
        const gate = gates[action]
        if (
          (action === 'buy' && gate.reason === 'no-offer') ||
          (action === 'bid' && gate.reason === 'no-auction') ||
          (action === 'register' && !gate.enabled)
        ) {
          return null
        }
        const signer = signerFor(action, view, viewers)
        const usable = gate.enabled && signer !== null && wallet !== null
        return (
          // A fragment, not a wrapper div: the rows stay siblings so
          // `.action-row:last-child` keeps trimming the final border, and the
          // sheet opens *under the row that was tapped* — it rendered after
          // the whole list until 2026-08-23, which put every sheet under the
          // last row (Kike, on the first live use of the ninth action).
          <Fragment key={action}>
            <div className="action-row">
              <span className="action-label">{ACTION_LABEL[action]}</span>
              {usable ? (
                <button type="button" className="action-go" onClick={() => setOpen(open === action ? null : action)}>
                  {open === action ? 'Close' : 'Open'}
                </button>
              ) : (
                <span className="action-state">{gate.reason !== null ? GATE_REASON_TEXT[gate.reason] : GATE_REASON_TEXT['no-viewer']}</span>
              )}
            </div>
            {open === action && wallet !== null && (
              <ActionSheet
                action={action}
                name={name}
                info={info}
                signer={signer ?? ''}
                viewers={viewers}
                wallet={wallet}
                onChanged={onChanged}
              />
            )}
          </Fragment>
        )
      })}
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
  onPay,
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
  /**
   * Buy passes this: a resolved card is an **address**, whatever the query was,
   * and paying it is the one thing every resolved card can offer — including a
   * delegated one, which has no name to act on at all. Seeded with the query as
   * typed, so `label.name` arrives at Pay whole. Null where the card is already
   * inside a send flow (Pay) or a management list (My names).
   */
  onPay: ((query: string) => void) | null
}) {
  const sender = wallet === null ? null : primaryAddress(wallet.identity)
  const viewers = wallet?.identity.addresses ?? []

  switch (outcome.kind) {
    case 'invalid':
      return <p className="field-error">{queryFaultLine(outcome.fault)}</p>

    case 'resolved': {
      const name = outcome.info?.name ?? outcome.result.name
      // Null for a delegated answer, which has no name-level actions at all —
      // `viewFor` holds the rule and the reason (states.ts).
      const view = viewFor(outcome)
      const mine = view !== null && onManage !== null && ownedByViewer(outcome, viewers)
      const record = outcome.info?.record ?? null
      const height = outcome.info?.height ?? null
      return (
        <RailCard tier={tierOf(outcome.result)}>
          <TitleName name={outcome.result.query} />
          <PinCheck query={outcome.result.query} address={outcome.result.address} />
          <AddressRow address={outcome.result.address} full />
          <VerificationLine result={outcome.result} />
          {outcome.info !== null && <Overlays info={outcome.info} nowMs={nowMs} />}
          {/* States doc §1/§6: expiry as ≈ date on the detail card, turning into
              the §10.4 renewal reminder inside the 60-day window — the list row
              in My names says it too, but the card is where a name is *looked at*. */}
          {record !== null && height !== null && record.status === 'REGISTERED' && (
            <p className="expiry-line">
              {renewalUrgency(record.expiry, height) === 'due' ? (
                <Badge tone="couldnt-check">{renewDueLine(formatApproxDate(approxDate(record.expiry, height, nowMs)))}</Badge>
              ) : (
                expiresLine(formatApproxDate(approxDate(record.expiry, height, nowMs)))
              )}
            </p>
          )}
          <WarningNotes warnings={outcome.result.warnings} />
          {/* Its own `.actions` group: one rule above it, and `:last-child`
              trims the row's own border. A delegated card's only action; on a
              plain one it sits above the name actions as a second group. */}
          {onPay !== null && (
            <div className="actions">
              <div className="action-row">
                <span className="action-label">{payThisLabel()}</span>
                <button type="button" className="action-go" onClick={() => onPay(outcome.result.query)}>
                  Open
                </button>
              </div>
            </div>
          )}
          {view === null ? (
            <p className="note note-info">{subdomainNotRegistrableLine(outcome.result.delegate?.parent ?? outcome.result.name)}</p>
          ) : mine ? (
            <div className="own-name">
              <p className="own-name-line">{ownNameLine()}</p>
              <button type="button" className="action-go" onClick={() => onManage(name)}>
                {manageOwnNameLabel()}
              </button>
            </div>
          ) : (
            <Actions actions={actions} view={view} wallet={wallet} onChanged={onChanged} />
          )}
          {outcome.info !== null && outcome.info.record !== null && !mine && (
            <details className="message-owner">
              <summary>{messageOwnerLabel()}</summary>
              <Composer name={outcome.info.name} recipient={outcome.info.record.owner} wallet={wallet} sender={sender} />
            </details>
          )}
          {/* A subdomain's message goes to the address it resolved to, with
              the dotted query as its subject. There is no owner to write to —
              §8.6 gives a label no record — and the parent's owner is a
              different party: whoever runs the host, not whoever holds the
              label (Kike, 2026-08-28). The address is the host's word, which
              the card already says above the composer. */}
          {view === null && (
            <details className="message-owner">
              <summary>{messageSubdomainLabel()}</summary>
              <p className="note note-info">{messageSubdomainNote(outcome.result.delegate?.parent ?? outcome.result.name)}</p>
              <Composer name={outcome.result.query} recipient={outcome.result.address} wallet={wallet} sender={sender} />
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
            <p>{justRegisteredLine()}</p>
          </RailCard>
        )
      }
      const view = viewFor(outcome)
      return (
        <RailCard tier={availability.verification === 'PROVEN' ? 'proven' : 'depth'}>
          <TitleName name={outcome.name} />
          <p className="available-line">{availableLine()}</p>
          <WarningNotes warnings={availability.warnings} />
          {view !== null && <Actions actions={actions} view={view} wallet={wallet} onChanged={onChanged} />}
        </RailCard>
      )
    }

    case 'grace': {
      const record = outcome.info?.record ?? null
      const height = outcome.info?.height ?? null
      const until =
        record !== null && height !== null
          ? formatApproxDate(approxDate(record.expiry + CONSTANTS.GRACE_PERIOD, height, nowMs))
          : graceEndsUnknownPhrase()
      const mine = onManage !== null && ownedByViewer(outcome, viewers)
      const view = viewFor(outcome)
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
            view !== null && <Actions actions={actions} view={view} wallet={wallet} onChanged={onChanged} />
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
              ? parentNotRegisteredLine(outcome.parent)
              : graceLine(graceEndsUnknownPhrase())}
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
