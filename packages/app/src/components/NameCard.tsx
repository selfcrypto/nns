/**
 * One rendering of a name, shared by **Buy** and **My names**, because the two
 * screens show the same card and must not drift into two.
 *
 * What differs between them is only which actions the card offers, and that is
 * a prop: discovery offers acquisition (`register`, `buy`), management offers
 * the owner set. Legality is not decided here — `actionGates` and `signerFor`
 * still say what is possible; this says what the screen is *for*.
 */

import { Fragment, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { CONSTANTS } from '@nns/core'
import { primaryAddress } from '../lib/identity'
import { approxDate, ellipsizeAddress, formatApproxDate, lunaToNim } from '../lib/format'
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
  manageThisLabel,
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
import { MessageModal } from './MessageModal'
import { PinCheck } from './PinCheck'
import { Badge, RailCard, type RailTier } from './ui'

/** Discovery: what someone who does not own the name can do with it. `buy` and `bid` never both show — state decides (§6 `A`). */
export const ACQUIRE_ACTIONS: readonly AppAction[] = ['register', 'buy', 'bid']

/** Management: the owner's eight, which live in My names and nowhere else. */
export const OWNER_ACTIONS: readonly AppAction[] = ['setTarget', 'setEvm', 'transfer', 'delegate', 'renew', 'offer', 'auction', 'cancel']

function Actions({
  actions,
  view,
  wallet,
  onChanged,
  onConnect,
  ctaMode,
  onMarket,
}: {
  actions: readonly AppAction[]
  /**
   * Built by the caller, because only the caller knows what the resolver said:
   * `nameView`'s unknown-state fallback is not guessable from here (states.ts).
   */
  view: NameView
  wallet: Wallet | null
  onChanged: () => void
  onConnect?: (() => void) | null | undefined
  /** When true, the button text IS the action label (e.g. "Register") rendered
   *  as a single full-width CTA instead of a label + "Details" pair. */
  ctaMode?: boolean
  onMarket?: ((name?: string) => void) | null | undefined
}) {
  const [open, setOpen] = useState<AppAction | null>(null)
  const { name, info } = view
  const viewers = wallet?.identity.addresses ?? []
  const gates = actionGates({ view, viewers, head: info?.height ?? 0 })

  useEffect(() => {
    if (open === null) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const handleActionClick = (action: AppAction) => {
    setOpen(open === action ? null : action)
  }

  const visibleActions = actions.filter((action) => {
    const gate = gates[action]
    if (action === 'buy' && gate.reason === 'no-offer') return false
    if (action === 'bid' && gate.reason === 'no-auction') return false
    if (action === 'register' && !gate.enabled) return false
    if (action === 'cancel' && gate.reason === 'nothing-to-cancel') return false
    return true
  })

  if (visibleActions.length === 0) return null

  const isOwnerActions = actions === OWNER_ACTIONS

  if (isOwnerActions) {
    const record = info?.record ?? null
    const height = info?.height ?? 0

    const groups: {
      title: string
      actions: AppAction[]
    }[] = [
      {
        title: 'Routing & Records',
        actions: ['setTarget', 'setEvm', 'delegate'],
      },
      {
        title: 'Ownership & Renewal',
        actions: ['renew', 'transfer'],
      },
      {
        title: 'Marketplace',
        actions: ['offer', 'auction', 'cancel'],
      },
    ]

    const actionMeta = (action: AppAction): { title: string; subtitle: string; icon: React.ReactNode; isDanger?: boolean } => {
      switch (action) {
        case 'setTarget':
          return {
            title: 'Target Address',
            subtitle: record?.target ? ellipsizeAddress(record.target) : 'Point to Nimiq address',
            icon: (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="6" />
                <circle cx="12" cy="12" r="2" />
              </svg>
            ),
          }
        case 'setEvm':
          return {
            title: 'EVM Resolution',
            subtitle: record?.evm ? ellipsizeAddress(record.evm) : 'Link USDC / USDT address',
            icon: (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            ),
          }
        case 'delegate':
          return {
            title: 'Subdomain Host',
            subtitle: record?.host ? record.host : 'Configure custom host',
            icon: (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            ),
          }
        case 'renew':
          return {
            title: 'Renew Registration',
            subtitle: record ? expiresLine(formatApproxDate(approxDate(record.expiry, height, Date.now()))) : 'Extend registration',
            icon: (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              </svg>
            ),
          }
        case 'transfer':
          return {
            title: 'Transfer Ownership',
            subtitle: 'Send to a new Nimiq owner',
            icon: (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M17 2.1l4 4-4 4" />
                <path d="M3 12.2v-2a4 4 0 0 1 4-4h14" />
                <path d="M7 21.9l-4-4 4-4" />
                <path d="M21 11.8v2a4 4 0 0 1-4 4H3" />
              </svg>
            ),
          }
        case 'offer':
          return {
            title: 'Sell (Fixed Price)',
            subtitle: info?.pending.offer ? `Active: ${lunaToNim(info.pending.offer.price)} NIM` : 'List for direct buy-now',
            icon: (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                <line x1="7" y1="7" x2="7.01" y2="7" />
              </svg>
            ),
          }
        case 'auction':
          return {
            title: 'Start Auction',
            subtitle: info?.pending.auction
              ? info.pending.auction.bidder
                ? `Standing bid: ${lunaToNim(info.pending.auction.bid)} NIM`
                : `Starting price: ${lunaToNim(info.pending.auction.startingPrice)} NIM`
              : 'Timed public bidding',
            icon: (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m14 13-7.5 7.5c-.83.83-2.17.83-3 0 0 0 0 0 0 0a2.12 2.12 0 0 1 0-3L11 10" />
                <path d="m16 16 6-6" />
                <path d="m8 8 6-6" />
                <path d="m9 7 8 8" />
                <path d="m21 11-8-8" />
              </svg>
            ),
          }
        case 'cancel':
          return {
            title: 'Cancel Listing',
            subtitle: info?.pending.offer ? 'Cancel fixed price offer' : 'Cancel active auction',
            icon: (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            ),
            isDanger: true,
          }
        default:
          return {
            title: ACTION_LABEL[action],
            subtitle: '',
            icon: null,
          }
      }
    }

    return (
      <div className="owner-actions-hub">
        {groups.map((group) => {
          const groupActions = group.actions.filter((action) => visibleActions.includes(action))
          if (groupActions.length === 0) return null
          return (
            <div key={group.title} className="owner-action-group">
              <span className="owner-action-group-title">{group.title}</span>
              <div className="owner-actions-grid">
                {groupActions.map((action) => {
                  const gate = gates[action]
                  const signer = signerFor(action, view, viewers)
                  const usable = gate.enabled && signer !== null && wallet !== null
                  const meta = actionMeta(action)
                  return (
                    <button
                      key={action}
                      type="button"
                      className={`owner-action-tile ${meta.isDanger ? 'is-danger' : ''}`}
                      disabled={!usable && !onConnect}
                      onClick={() => {
                        if (!usable && onConnect) {
                          onConnect()
                        } else {
                          handleActionClick(action)
                        }
                      }}
                    >
                      <div className="owner-action-icon">{meta.icon}</div>
                      <div className="owner-action-info">
                        <span className="owner-action-name">{meta.title}</span>
                        <span className="owner-action-meta">
                          {!usable && gate.reason !== null
                            ? GATE_REASON_TEXT[gate.reason]
                            : !usable && wallet === null
                              ? 'Connect wallet'
                              : meta.subtitle}
                        </span>
                      </div>
                      <svg className="owner-action-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}

        {open !== null && wallet !== null && typeof document !== 'undefined' && createPortal(
          <>
            <div className="action-modal-scrim" onClick={() => setOpen(null)} aria-hidden="true" />
            <div className="action-modal-container" role="dialog" aria-modal="true" aria-labelledby="action-modal-title">
              <div className="action-modal-handle" aria-hidden="true" />
              <ActionSheet
                action={open}
                name={name}
                info={info}
                signer={signerFor(open, view, viewers) ?? ''}
                viewers={viewers}
                wallet={wallet}
                onChanged={() => {
                  setOpen(null)
                  onChanged()
                }}
                onClose={() => setOpen(null)}
              />
            </div>
          </>,
          document.body
        )}
      </div>
    )
  }

  return (
    <div className="actions">
      {visibleActions.map((action) => {
        const gate = gates[action]
        const signer = signerFor(action, view, viewers)
        const usable = gate.enabled && signer !== null && wallet !== null

        const isMarketplaceAction = (action === 'buy' || action === 'bid') && ctaMode

        if (isMarketplaceAction) {
          const offer = info?.pending.offer
          const auction = info?.pending.auction

          let priceStr = ''
          let isAuction = false

          if (action === 'buy' && offer) {
            priceStr = `${lunaToNim(offer.price)} NIM`
          } else if (action === 'bid' && auction) {
            isAuction = true
            priceStr =
              auction.bidder === null
                ? `${lunaToNim(auction.startingPrice)} NIM`
                : `${lunaToNim(auction.bid)} NIM`
          }

          const handleCheckNow = () => {
            if (onMarket) {
              onMarket(name)
            }
          }

          return (
            <Fragment key={action}>
              <div className="action-row-marketplace">
                <span className="marketplace-listing-line">
                  {isAuction
                    ? `Listed at the marketplace for bidding (${priceStr}). `
                    : `Listed at the marketplace for ${priceStr}. `}
                  <button
                    type="button"
                    className="marketplace-check-now"
                    onClick={handleCheckNow}
                  >
                    Check now.
                  </button>
                </span>
              </div>
            </Fragment>
          )
        }

        return (
          <Fragment key={action}>
            {(!ctaMode || open !== action) && (
              <div className={`action-row ${ctaMode ? 'action-row-cta' : ''}`}>
                {!ctaMode && <span className="action-label">{ACTION_LABEL[action]}</span>}
                {usable ? (
                  <button
                    type="button"
                    className="action-go"
                    onClick={() => handleActionClick(action)}
                  >
                    {open === action ? 'Close' : ctaMode ? ACTION_LABEL[action] : 'Details'}
                  </button>
                ) : onConnect ? (
                  <button type="button" className="action-go action-connect" onClick={onConnect}>
                    {ctaMode ? `Connect to ${ACTION_LABEL[action]}` : 'Connect Wallet'}
                  </button>
                ) : (
                  <span className="action-state">{gate.reason !== null ? GATE_REASON_TEXT[gate.reason] : GATE_REASON_TEXT['no-viewer']}</span>
                )}
              </div>
            )}
          </Fragment>
        )
      })}

      {open !== null && wallet !== null && typeof document !== 'undefined' && createPortal(
        <>
          <div className="action-modal-scrim" onClick={() => setOpen(null)} aria-hidden="true" />
          <div className="action-modal-container" role="dialog" aria-modal="true">
            <div className="action-modal-handle" aria-hidden="true" />
            <ActionSheet
              action={open}
              name={name}
              info={info}
              signer={signerFor(open, view, viewers) ?? ''}
              viewers={viewers}
              wallet={wallet}
              onChanged={() => {
                setOpen(null)
                onChanged()
              }}
              onClose={() => setOpen(null)}
            />
          </div>
        </>,
        document.body
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
  onConnect,
  onManage,
  onPay,
  onMarket,
  seamless = false,
}: {
  outcome: SearchOutcome
  wallet: Wallet | null
  nowMs: number
  actions: readonly AppAction[]
  onChanged: () => void
  onConnect?: (() => void) | null | undefined
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
  onMarket?: ((name?: string) => void) | null | undefined
  seamless?: boolean
}) {
  const [messageOpen, setMessageOpen] = useState(false)
  const sender = wallet === null ? null : primaryAddress(wallet.identity)
  const viewers = wallet?.identity.addresses ?? []

  const wrap = (tier: RailTier, content: React.ReactNode) =>
    seamless ? <>{content}</> : <RailCard tier={tier}>{content}</RailCard>

  switch (outcome.kind) {
    case 'invalid':
      return <p className="field-error">{queryFaultLine(outcome.fault)}</p>

    case 'resolved': {
      const name = outcome.info?.name ?? outcome.result.name
      // Null for a delegated answer, which has no name-level actions at all —
      // `viewFor` holds the rule and the reason (states.ts).
      const view = viewFor(outcome)
      const isOwner = ownedByViewer(outcome, viewers)
      const mine = view !== null && onManage !== null && isOwner
      const record = outcome.info?.record ?? null
      const height = outcome.info?.height ?? null
      // Verification and expiry details are shown in My Names management detail, not on the Buy / Search discovery card.
      const showMeta = onManage === null && actions === OWNER_ACTIONS

      const canMessageOwner = outcome.info !== null && outcome.info.record !== null && !isOwner && actions !== OWNER_ACTIONS
      const canMessageSubdomain = view === null && actions !== OWNER_ACTIONS && !viewers.some((address) => sameAddress(address, outcome.result.address))
      const canMessage = canMessageOwner || canMessageSubdomain
      const messageRecipient = canMessageOwner ? outcome.info.record.owner : canMessageSubdomain ? outcome.result.address : null
      const messageTargetName = canMessageOwner ? outcome.info.name : outcome.result.query
      const subdomainNote = canMessageSubdomain ? messageSubdomainNote(outcome.result.delegate?.parent ?? outcome.result.name) : null
      const messageLabel = canMessageSubdomain ? messageSubdomainLabel() : messageOwnerLabel()

      return wrap(
        tierOf(outcome.result),
        <div className="resolved-card-premium">
            <div className="resolved-header">
              <div className="available-title-row">
                <TitleName name={outcome.result.query} />
                {isOwner ? (
                  <span className="owner-status-tag">
                    <span className="owner-dot" aria-hidden="true" />
                    You own this
                  </span>
                ) : (
                  <span className="resolved-status-tag">
                    <span className="resolved-dot" aria-hidden="true" />
                    Registered
                  </span>
                )}
              </div>
            </div>
            <PinCheck query={outcome.result.query} address={outcome.result.address} />
            <div className="address-card-wrap">
              <AddressRow address={outcome.result.address} full />
            </div>
            {showMeta && (
              <div className="resolved-meta-section">
                <VerificationLine result={outcome.result} />
              </div>
            )}
            {outcome.info !== null && <Overlays info={outcome.info} nowMs={nowMs} hideMarketplace={actions === ACQUIRE_ACTIONS || !isOwner} />}
            <WarningNotes warnings={outcome.result.warnings} />
            {mine ? (
              <div className="resolved-actions-grid">
                {onPay !== null && (
                  <button
                    type="button"
                    className="btn-action-primary"
                    onClick={() => onPay(outcome.result.query)}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="7" y1="17" x2="17" y2="7" />
                      <polyline points="7 7 17 7 17 17" />
                    </svg>
                    <span>{payThisLabel()}</span>
                  </button>
                )}
                <button
                  type="button"
                  className="btn-action-secondary"
                  onClick={() => onManage(name)}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  <span>{manageThisLabel()}</span>
                </button>
              </div>
            ) : (
              <div className="resolved-actions-stack">
                {(onPay !== null || canMessage) && (
                  <div className="resolved-actions-grid">
                    {onPay !== null && (
                      <button
                        type="button"
                        className="btn-action-primary"
                        onClick={() => onPay(outcome.result.query)}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <line x1="7" y1="17" x2="17" y2="7" />
                          <polyline points="7 7 17 7 17 17" />
                        </svg>
                        <span>{payThisLabel()}</span>
                      </button>
                    )}
                    {canMessage && (
                      <button
                        type="button"
                        className="btn-action-secondary message-owner-btn"
                        onClick={() => setMessageOpen(true)}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                        <span>{messageLabel}</span>
                      </button>
                    )}
                  </div>
                )}
                {view === null ? (
                  <p className="note note-info">{subdomainNotRegistrableLine(outcome.result.delegate?.parent ?? outcome.result.name)}</p>
                ) : (
                  <Actions actions={actions} view={view} wallet={wallet} onChanged={onChanged} onConnect={onConnect} ctaMode onMarket={onMarket} />
                )}
              </div>
            )}
            {canMessage && (
              <MessageModal
                isOpen={messageOpen}
                onClose={() => setMessageOpen(false)}
                name={messageTargetName}
                recipient={messageRecipient}
                wallet={wallet}
                sender={sender}
                subdomainNote={subdomainNote}
                onConnect={onConnect}
              />
            )}
          </div>
        )
      }

    case 'availability': {
      const { availability } = outcome
      if (!availability.available) {
        if (availability.reason === 'RESERVED') {
          return wrap(
            'plain',
            <div className="reserved-card-premium">
              <div className="reserved-header">
                <div className="available-title-row">
                  <TitleName name={outcome.name} />
                  <span className="reserved-status-tag">
                    <span className="reserved-dot" aria-hidden="true" />
                    Reserved
                  </span>
                </div>
              </div>
              <div className="reserved-info-box">
                <div className="reserved-icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                  </svg>
                </div>
                <p className="reserved-text">{reservedLine()}</p>
              </div>
              <WarningNotes warnings={availability.warnings} />
            </div>
          )
        }
        return wrap(
          'plain',
          <div className="reserved-card-premium">
            <div className="reserved-header">
              <div className="available-title-row">
                <TitleName name={outcome.name} />
                <span className="taken-status-tag">
                  <span className="taken-dot" aria-hidden="true" />
                  Taken
                </span>
              </div>
            </div>
            <div className="reserved-info-box">
              <p className="reserved-text">{justRegisteredLine()}</p>
            </div>
            <WarningNotes warnings={availability.warnings} />
          </div>
        )
      }
      const view = viewFor(outcome)
      return wrap(
        availability.verification === 'PROVEN' ? 'proven' : 'depth',
        <div className="available-card-premium">
          <div className="available-header">
            <div className="available-title-row">
              <TitleName name={outcome.name} />
              <span className="available-status-tag">
                <span className="available-dot" aria-hidden="true" />
                {availableLine()}
              </span>
            </div>
          </div>
          <WarningNotes warnings={availability.warnings} />
          {view !== null && (
            <div className="available-actions">
              <Actions actions={actions} view={view} wallet={wallet} onChanged={onChanged} onConnect={onConnect} ctaMode onMarket={onMarket} />
            </div>
          )}
        </div>
      )
    }

    case 'grace': {
      const record = outcome.info?.record ?? null
      const height = outcome.info?.height ?? null
      const until =
        record !== null && height !== null
          ? formatApproxDate(approxDate(record.expiry + CONSTANTS.GRACE_PERIOD, height, nowMs))
          : graceEndsUnknownPhrase()
      const isOwner = ownedByViewer(outcome, viewers)
      const mine = onManage !== null && isOwner
      const view = viewFor(outcome)
      return wrap(
        'plain',
        <div className="grace-card-premium">
          <div className="grace-header">
            <div className="available-title-row">
              <TitleName name={outcome.name} />
              {isOwner ? (
                <span className="owner-status-tag">
                  <span className="owner-dot" aria-hidden="true" />
                  You own this
                </span>
              ) : (
                <span className="grace-status-tag">
                  <span className="grace-dot" aria-hidden="true" />
                  In Grace
                </span>
              )}
            </div>
          </div>

          <div className="grace-info-box">
            <div className="grace-icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
            </div>
            <p className="grace-text">{graceLine(until)}</p>
          </div>

          {mine ? (
            <div className="resolved-actions-grid" style={{ marginTop: '16px' }}>
              <button
                type="button"
                className="btn-action-secondary"
                onClick={() => onManage(outcome.name)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                <span>{manageThisLabel()}</span>
              </button>
            </div>
          ) : (
            view !== null && (
              <div className="available-actions" style={{ marginTop: '16px' }}>
                <Actions actions={actions} view={view} wallet={wallet} onChanged={onChanged} onConnect={onConnect} ctaMode onMarket={onMarket} />
              </div>
            )
          )}
        </div>
      )
    }

    case 'parent-state':
      return wrap(
        'plain',
        <div className="reserved-card-premium">
          <div className="reserved-header">
            <div className="available-title-row">
              <TitleName name={outcome.parent} />
              <span className="taken-status-tag">
                <span className="taken-dot" aria-hidden="true" />
                {outcome.code === 'NOT_FOUND' ? 'Not Registered' : 'In Grace'}
              </span>
            </div>
          </div>
          <div className="reserved-info-box">
            <div className="reserved-icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
            </div>
            <p className="reserved-text">
              {outcome.code === 'NOT_FOUND'
                ? parentNotRegisteredLine(outcome.parent)
                : graceLine(graceEndsUnknownPhrase())}
            </p>
          </div>
        </div>
      )

    case 'delegate-failed':
      return (
        <div className="stack">
          {wrap(
            'plain',
            <div className="reserved-card-premium">
              <div className="reserved-header">
                <div className="available-title-row">
                  <TitleName name={outcome.query} />
                  <span className="taken-status-tag">
                    <span className="taken-dot" aria-hidden="true" />
                    Subdomain Error
                  </span>
                </div>
              </div>
              <div className="reserved-info-box">
                <div className="reserved-icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="12"></line>
                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                  </svg>
                </div>
                <p className="reserved-text">
                  {outcome.code === 'PARENT_NOT_DELEGATING'
                    ? parentNotDelegatingLine(outcome.parent?.name ?? outcome.query.split('.')[1] ?? '')
                    : delegateFailedLine(outcome.parent?.name ?? outcome.query.split('.')[1] ?? '')}
                </p>
              </div>
            </div>
          )}
          {outcome.parent !== null && (
            <RailCard tier={tierOf(outcome.parent)}>
              <div className="resolved-card-premium">
                <div className="resolved-header">
                  <div className="available-title-row">
                    <TitleName name={outcome.parent.name} />
                    <span className="resolved-status-tag">
                      <span className="resolved-dot" aria-hidden="true" />
                      Parent Name
                    </span>
                  </div>
                </div>
                <div className="address-card-wrap">
                  <AddressRow address={outcome.parent.address} full />
                </div>
                <VerificationLine result={outcome.parent} />
              </div>
            </RailCard>
          )}
        </div>
      )

    case 'alarm':
      return (
        <RailCard tier="alarm">
          <div className="reserved-card-premium" style={{ background: 'transparent' }}>
            <div className="reserved-header">
              <div className="available-title-row">
                <h2 className="result-name" style={{ color: 'var(--alarm)' }}>{alarmHeadline()}</h2>
                <span className="taken-status-tag" style={{ color: 'var(--alarm)', borderColor: 'var(--alarm)' }}>
                  <span className="taken-dot" style={{ background: 'var(--alarm)' }} aria-hidden="true" />
                  Security Alarm
                </span>
              </div>
            </div>
            <div className="reserved-info-box">
              <p className="reserved-text">{alarmBody(outcome.code)}</p>
            </div>
            <p className="note note-info" style={{ marginTop: '12px' }}>{outcome.message}</p>
          </div>
        </RailCard>
      )

    case 'unreachable':
      return (
        <RailCard tier="plain">
          <div className="reserved-card-premium">
            <div className="reserved-header">
              <div className="available-title-row">
                <h2 className="result-name">Registry</h2>
                <span className="taken-status-tag">
                  <span className="taken-dot" aria-hidden="true" />
                  Unreachable
                </span>
              </div>
            </div>
            <div className="reserved-info-box">
              <p className="reserved-text">{unreachableLine()}</p>
            </div>
          </div>
        </RailCard>
      )
  }
}
