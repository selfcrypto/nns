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
import { type CopyOutcome, writeClipboard } from '../lib/clipboard'
import { apiBase } from '../lib/nns'
import { getParams, getReferrals } from '../lib/api'
import { shareLinkFor } from '../lib/referral'
import { percentOf, rateIsNetOfBurn, rebatePercent, referralHeadlineBp, referralRateBp, shareAmount } from '../lib/referralRates'
import { useAsync } from '../lib/useAsync'
import { Hint } from './Hint'
import { createPortal } from 'react-dom'
import { CONSTANTS } from '@nimiqnames/core'
import { primaryAddress } from '../lib/identity'
import { approxDate, ellipsizeAddress, formatApproxWhen, lunaToNim } from '../lib/format'
import type { SearchOutcome } from '../lib/search'
import { actionGates, cancellableNow, cancelTileGroup, connectInstead, registrationFee, renewalUrgency, sameAddress, signerFor, viewFor, type AppAction, type NameView } from '../lib/states'
import type { Wallet } from '../lib/wallet'
import { IdentityBar } from './IdentityBar'
import {
  ACTION_LABEL,
  GATE_REASON_TEXT,
  OWNER_GROUP_TITLE,
  OWNER_TILE,
  SHARE_TILE,
  ownerShareLine,
  referralsCountLine,
  shareCopiedLine,
  shareCopyFailedLine,
  shareHint,
  shareInGraceLine,
  STATUS_TAG,
  alarmBody,
  alarmHeadline,
  auctionStandingLine,
  auctionStartingLine,
  availableLine,
  cancelHint,
  cancelTitle,
  checkNowLabel,
  closeLabel,
  connectWalletHint,
  delegateFailedLine,
  detailsLabel,
  expiresLine,
  ownedUntilLine,
  registeredUntilLine,
  graceEndsUnknownPhrase,
  graceLine,
  justRegisteredLine,
  listedForBiddingLine,
  listedForSaleLine,
  manageOwnNameLabel,
  manageThisLabel,
  messageOwnerLabel,
  messageSubdomainLabel,
  messageSubdomainNote,
  offerActiveLine,
  ownNameLine,
  parentNotDelegatingLine,
  parentNotRegisteredLine,
  payThisLabel,
  queryFaultLine,
  registryHeading,
  renewDueLine,
  reservedLine,
  subdomainNotRegistrableLine,
  propagatingLine,
  propagatingRetryLine,
  unreachableLine,
  giftRenewalLabel,
  REQUEST_TILE,
  requestInGraceLine,
} from '../lib/wording'
import { ClockIcon } from './icons'
import { AnswerBlock, Overlays, QuorumReplies, TitleName, WarningNotes, tierOf } from './result'
import { ActionSheet } from './ActionSheet'
import { MessageModal } from './MessageModal'
import { PaymentRequestSheet } from './PaymentRequestSheet'
import { PinCheck } from './PinCheck'
import { Badge, RailCard, type RailTier } from './ui'

/** Discovery: what someone who does not own the name can do with it. `buy` and `bid` never both show — state decides (§6 `A`). */
/** `renew` here is the gift: anyone may send an `N` (§6), and the label says so. */
export const ACQUIRE_ACTIONS: readonly AppAction[] = ['register', 'renew', 'buy', 'bid']

/** Management: the owner's eight, which live in My names and nowhere else. */
export const OWNER_ACTIONS: readonly AppAction[] = ['setTarget', 'setEvm', 'transfer', 'delegate', 'renew', 'offer', 'auction', 'cancel']

/**
 * §10.7's owner half: the link, and what it has earned. Not a transaction —
 * the tile copies `?ref=<name>` and reads `/referrals/{name}` for the count;
 * the estimate applies today's band prices and the published rate, which is
 * why it says so. In grace the name cannot refer (the registry reads the
 * referrer's status at the registration), so the tile says to renew first.
 */
function ShareTile({ name, height, inGrace }: { name: string; height: number; inGrace: boolean }) {
  const [copied, setCopied] = useState<CopyOutcome | null>(null)
  const referrals = useAsync(() => getReferrals(apiBase(), name), [name])
  const params = useAsync(() => getParams(apiBase()), [])
  // The rate the payer **sends**, not the headline the hint states: this is an
  // estimate in NIM, and the burn comes out before the transfer does.
  const bp = referralRateBp(name, height) ?? 0n
  const link = shareLinkFor(name)

  useEffect(() => {
    if (copied === null) return
    const timer = setTimeout(() => setCopied(null), 2_500)
    return () => clearTimeout(timer)
  }, [copied])

  const earned = ((): string => {
    if (referrals.status !== 'done') return SHARE_TILE.hint
    if (params.status !== 'done') return referralsCountLine(referrals.value.count, '…')
    let total = 0n
    for (const item of referrals.value.registrations) {
      // The share is taken on the fee owed, so a lifetime registration
      // counts ten yearly fees (settlement's `share.ts`, 2026-09-11).
      total += shareAmount(registrationFee(item.name, params.value, item.lifetime), bp)
    }
    return referralsCountLine(referrals.value.count, lunaToNim(total))
  })()

  const copy = () => void writeClipboard(link).then(setCopied)

  return (
    <button
      type="button"
      className="owner-action-tile"
      disabled={inGrace}
      onClick={() => void copy()}
    >
      <div className="owner-action-icon">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
        </svg>
      </div>
      <div className="owner-action-info">
        <span className="owner-action-name">{SHARE_TILE.title}</span>
        <span className="owner-action-meta">
          {inGrace ? shareInGraceLine() : copied === 'ok' ? shareCopiedLine() : copied === 'failed' ? shareCopyFailedLine(link) : earned}
        </span>
      </div>
      <svg className="owner-action-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
  )
}

/**
 * The payment link (`lib/payRequest.ts`): a link to this name's Pay screen
 * with the amount and the reference already in it. Not a transaction — the
 * tile opens a sheet that assembles a string.
 *
 * Disabled in grace, and for a different reason than `ShareTile`'s: a name in
 * grace **does not resolve** (§7.3, docs/app-states.md), so a link naming it
 * would open Pay on the grace card with nothing payable.
 */
function RequestTile({ name, hasEvm, inGrace }: { name: string; hasEvm: boolean; inGrace: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="owner-action-tile" disabled={inGrace} onClick={() => setOpen(true)}>
        <div className="owner-action-icon">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2" y="5" width="20" height="14" rx="3" />
            <line x1="2" y1="10" x2="22" y2="10" />
            <line x1="6" y1="15" x2="10" y2="15" />
          </svg>
        </div>
        <div className="owner-action-info">
          <span className="owner-action-name">{REQUEST_TILE.title}</span>
          <span className="owner-action-meta">{inGrace ? requestInGraceLine() : REQUEST_TILE.hint}</span>
        </div>
        <svg className="owner-action-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      <PaymentRequestSheet name={name} hasEvm={hasEvm} isOpen={open} onClose={() => setOpen(false)} />
    </>
  )
}

function Actions({
  actions,
  view,
  wallet,
  onChanged,
  onConnect,
  ctaMode,
  onMarket,
  openAction = null,
  onOpenActionHandled,
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
  /** A sheet the surrounding screen asks for — My names' expiry badge opens
   *  `renew`. Consumed once, the way `MyNamesScreen` consumes `manage`. */
  openAction?: AppAction | null | undefined
  onOpenActionHandled?: (() => void) | undefined
}) {
  const [open, setOpen] = useState<AppAction | null>(null)
  const { name, info } = view
  const viewers = wallet?.identity.addresses ?? []
  const gates = actionGates({ view, viewers, head: info?.height ?? 0 })
  // No address yet, so the row's job is to offer the wallet, not to explain a
  // gate. `wallet === null` is detection in flight and was never this state
  // (states.ts, `connectInstead`).
  const offerConnect = connectInstead(wallet, onConnect != null)

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

  /** Whether tapping this action opens its sheet — the tile's own test (below),
   *  so an outside request behaves exactly like tapping the tile. */
  const usableAction = (action: AppAction): boolean =>
    gates[action].enabled && signerFor(action, view, viewers) !== null && wallet !== null

  useEffect(() => {
    if (openAction == null) return
    if (usableAction(openAction)) setOpen(openAction)
    else if (offerConnect && onConnect != null) onConnect()
    onOpenActionHandled?.()
    // Only `openAction`: the request is consumed once, on arrival.
  }, [openAction])

  const visibleActions = actions.filter((action) => {
    const gate = gates[action]
    if (action === 'buy' && gate.reason === 'no-offer') return false
    if (action === 'bid' && gate.reason === 'no-auction') return false
    if (action === 'register' && !gate.enabled) return false
    if (action === 'cancel' && gate.reason === 'nothing-to-cancel') return false
    // The gift renewal (Buy) is offered only where it is a gift: a name that
    // exists and that none of the viewer's addresses holds. On My names the
    // owner's own renew tile stays visible with its reason, like every tile.
    if (action === 'renew' && actions !== OWNER_ACTIONS) {
      const owner = info?.record?.owner
      if (!gate.enabled || owner === undefined) return false
      if (viewers.some((viewer) => sameAddress(owner, viewer))) return false
    }
    return true
  })

  if (visibleActions.length === 0) return null

  const isOwnerActions = actions === OWNER_ACTIONS

  if (isOwnerActions) {
    const record = info?.record ?? null
    const height = info?.height ?? 0

    // What a `K` would actually clear, and therefore what the tile is called and
    // where it sits (§6 `K`: one `K` clears the whole set at once).
    const cancellable = cancellableNow(info, height)
    const cancelInOwnership = cancelTileGroup(cancellable) === 'ownership'
    // The headline the owner is shown, on the group title and in its hint.
    const sharePercent = percentOf(referralHeadlineBp(name, height) ?? 0)

    const groups: {
      title: string
      actions: AppAction[]
    }[] = [
      {
        title: OWNER_GROUP_TITLE.records,
        actions: ['setTarget', 'setEvm', 'delegate'],
      },
      {
        title: OWNER_GROUP_TITLE.ownership,
        // Listed exactly once across the two groups: `cancel` in both renders
        // the tile twice, since each group filters `visibleActions` itself.
        actions: cancelInOwnership ? ['renew', 'transfer', 'cancel'] : ['renew', 'transfer'],
      },
      {
        title: OWNER_GROUP_TITLE.market,
        actions: cancelInOwnership ? ['offer', 'auction'] : ['offer', 'auction', 'cancel'],
      },
    ]

    const actionMeta = (action: AppAction): { title: string; subtitle: string; icon: React.ReactNode; isDanger?: boolean } => {
      switch (action) {
        case 'setTarget':
          return {
            title: OWNER_TILE.setTarget.title,
            subtitle: record?.target ? ellipsizeAddress(record.target) : OWNER_TILE.setTarget.hint,
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
            title: OWNER_TILE.setEvm.title,
            subtitle: record?.evm ? ellipsizeAddress(record.evm) : OWNER_TILE.setEvm.hint,
            icon: (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            ),
          }
        case 'delegate':
          return {
            title: OWNER_TILE.delegate.title,
            subtitle: record?.host ? record.host : OWNER_TILE.delegate.hint,
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
            title: OWNER_TILE.renew.title,
            subtitle: record ? expiresLine(formatApproxWhen(approxDate(record.expiry, height, Date.now()), Date.now())) : OWNER_TILE.renew.hint,
            icon: (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              </svg>
            ),
          }
        case 'transfer':
          return {
            title: OWNER_TILE.transfer.title,
            subtitle: OWNER_TILE.transfer.hint,
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
            title: OWNER_TILE.offer.title,
            subtitle: info?.pending.offer ? offerActiveLine(lunaToNim(info.pending.offer.price)) : OWNER_TILE.offer.hint,
            icon: (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                <line x1="7" y1="7" x2="7.01" y2="7" />
              </svg>
            ),
          }
        case 'auction':
          return {
            title: OWNER_TILE.auction.title,
            subtitle: info?.pending.auction
              ? info.pending.auction.bidder
                ? auctionStandingLine(lunaToNim(info.pending.auction.bid))
                : auctionStartingLine(lunaToNim(info.pending.auction.startingPrice))
              : OWNER_TILE.auction.hint,
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
            title: cancelTitle(cancellable),
            subtitle: cancelHint(cancellable, {
              to: info?.pending.transfer ? ellipsizeAddress(info.pending.transfer.newOwner) : null,
              priceNim: cancellable.offer && info?.pending.offer ? lunaToNim(info.pending.offer.price) : null,
              leftBlocks:
                cancellable.transfer && info?.pending.transfer ? info.pending.transfer.effectiveHeight - info.height : null,
            }),
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
                  // Connect is the answer to *no wallet*, never to a gated
                  // action: a connected owner tapping "renew" in the wrong
                  // window got the Hub's connect popup for one build.
                  const canConnect = offerConnect && onConnect != null
                  const meta = actionMeta(action)
                  return (
                    <button
                      key={action}
                      type="button"
                      className={`owner-action-tile ${meta.isDanger ? 'is-danger' : ''}`}
                      disabled={!usable && !canConnect}
                      onClick={() => {
                        if (usable) handleActionClick(action)
                        else if (canConnect) onConnect()
                      }}
                    >
                      <div className="owner-action-icon">{meta.icon}</div>
                      <div className="owner-action-info">
                        <span className="owner-action-name">{meta.title}</span>
                        <span className="owner-action-meta">
                          {!usable && gate.reason !== null
                            ? GATE_REASON_TEXT[gate.reason]
                            : !usable && offerConnect
                              ? connectWalletHint()
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

        {record !== null && (
          <div className="owner-action-group">
            <span className="owner-action-group-title">{OWNER_GROUP_TITLE.payments}</span>
            <div className="owner-actions-grid">
              <RequestTile name={name} hasEvm={(record.evm ?? '') !== ''} inGrace={record.status === 'GRACE'} />
            </div>
          </div>
        )}

        {record !== null && (
          <div className="owner-action-group">
            <span className="owner-action-group-title">
              {OWNER_GROUP_TITLE.referrals}
              <span className="owner-action-group-rate">{ownerShareLine(sharePercent)}</span>
              <Hint>{shareHint(sharePercent, rebatePercent(name, height), rateIsNetOfBurn(name, height))}</Hint>
            </span>
            <div className="owner-actions-grid">
              <ShareTile name={name} height={height} inGrace={record.status === 'GRACE'} />
            </div>
          </div>
        )}

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
        const label = action === 'renew' && actions !== OWNER_ACTIONS ? giftRenewalLabel() : ACTION_LABEL[action]

        const isMarketplaceAction = (action === 'buy' || action === 'bid') && ctaMode

        if (isMarketplaceAction) {
          const offer = info?.pending.offer
          const auction = info?.pending.auction

          let priceStr = ''
          let isAuction = false

          if (action === 'buy' && offer) {
            priceStr = lunaToNim(offer.price)
          } else if (action === 'bid' && auction) {
            isAuction = true
            priceStr = auction.bidder === null ? lunaToNim(auction.startingPrice) : lunaToNim(auction.bid)
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
                  {isAuction ? listedForBiddingLine(priceStr) : listedForSaleLine(priceStr)}
                  <button
                    type="button"
                    className="marketplace-check-now"
                    onClick={handleCheckNow}
                  >
                    {checkNowLabel()}
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
                {!ctaMode && <span className="action-label">{label}</span>}
                {usable ? (
                  <button
                    type="button"
                    className="action-go"
                    onClick={() => handleActionClick(action)}
                  >
                    {open === action ? closeLabel() : ctaMode ? label : detailsLabel()}
                  </button>
                ) : offerConnect ? (
                  /* The masthead's control, moved — not a second one. The card
                     had a connect button of its own, and it was drawn on
                     `wallet === null`, so it never appeared for the user who
                     needed it. */
                  <IdentityBar
                    wallet={wallet}
                    onConnect={onConnect ?? null}
                    onDisconnect={null}
                    expanded={false}
                    onToggle={() => {}}
                    placement="empty"
                  />
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
  openAction = null,
  onOpenActionHandled,
  seamless = false,
  retrying = false,
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
  /**
   * A sheet the surrounding screen asks the card to open — My names' expiry
   * badge is a shortcut to `renew`. The card owns the sheets, so a screen that
   * wants one says which and the card decides whether it is usable, exactly as
   * a tap on the tile would.
   */
  openAction?: AppAction | null | undefined
  onOpenActionHandled?: (() => void) | undefined
  seamless?: boolean
  /** A `propagating` outcome: whether the screen is still asking again on its own. */
  retrying?: boolean
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

      const canMessageOwner = outcome.info !== null && outcome.info.record !== null && !isOwner && actions !== OWNER_ACTIONS
      const canMessageSubdomain = view === null && actions !== OWNER_ACTIONS && !viewers.some((address) => sameAddress(address, outcome.result.address))
      const canMessage = canMessageOwner || canMessageSubdomain
      const messageRecipient = canMessageOwner ? outcome.info.record.owner : canMessageSubdomain ? outcome.result.address : null
      const messageTargetName = canMessageOwner ? outcome.info.name : outcome.result.query
      const subdomainNote = canMessageSubdomain ? messageSubdomainNote(outcome.result.delegate?.parent ?? outcome.result.name) : null
      const messageLabel = canMessageSubdomain ? messageSubdomainLabel() : messageOwnerLabel()
      // When the term ends — app-states §1/§6 — and the §10.4 reminder inside
      // the 60-day window. Both ride the status tag: "Registered" without a
      // date withholds the fact that gives the word its meaning, and on its
      // own line it spent a line to repeat a word (Kike, 2026-09-15).
      const expiryDate =
        record !== null && height !== null && record.status === 'REGISTERED'
          ? formatApproxWhen(approxDate(record.expiry, height, nowMs), nowMs)
          : null
      const renewDue = record !== null && height !== null && expiryDate !== null && renewalUrgency(record.expiry, height) === 'due'

      return wrap(
        tierOf(outcome.result),
        <div className="resolved-card-premium">
            <div className="resolved-header">
              <div className="available-title-row">
                <TitleName name={outcome.result.query} />
                {isOwner ? (
                  <span className={`owner-status-tag ${renewDue ? 'is-due' : ''}`}>
                    <span className="owner-dot" aria-hidden="true" />
                    {expiryDate === null
                      ? STATUS_TAG.owned
                      : renewDue
                        ? renewDueLine(expiryDate)
                        : ownedUntilLine(expiryDate)}
                  </span>
                ) : (
                  <span className={`resolved-status-tag ${renewDue ? 'is-due' : ''}`}>
                    <span className="resolved-dot" aria-hidden="true" />
                    {view === null
                      ? STATUS_TAG.subdomain
                      : expiryDate === null
                        ? STATUS_TAG.registered
                        : renewDue
                          ? renewDueLine(expiryDate)
                          : registeredUntilLine(expiryDate)}
                  </span>
                )}
              </div>
            </div>
            <PinCheck query={outcome.result.query} address={outcome.result.address} />
            {/* On every resolved card, Buy included: who verified, by name and
                URL, or that a delegate answered — §8.5 #6 and app-states §5.
                The redesign kept it for My names only, which left a verified
                name and a delegate's word looking identical on the front door. */}
            <AnswerBlock result={outcome.result} />
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
                  <Actions actions={actions} view={view} wallet={wallet} onChanged={onChanged} onConnect={onConnect} ctaMode onMarket={onMarket} openAction={openAction} onOpenActionHandled={onOpenActionHandled} />
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
                    {STATUS_TAG.reserved}
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
                  {STATUS_TAG.taken}
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
              <Actions actions={actions} view={view} wallet={wallet} onChanged={onChanged} onConnect={onConnect} ctaMode onMarket={onMarket} openAction={openAction} onOpenActionHandled={onOpenActionHandled} />
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
          ? formatApproxWhen(approxDate(record.expiry + CONSTANTS.GRACE_PERIOD, height, nowMs), nowMs)
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
                  {STATUS_TAG.owned}
                </span>
              ) : (
                <span className="grace-status-tag">
                  <span className="grace-dot" aria-hidden="true" />
                  {STATUS_TAG.grace}
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
                <Actions actions={actions} view={view} wallet={wallet} onChanged={onChanged} onConnect={onConnect} ctaMode onMarket={onMarket} openAction={openAction} onOpenActionHandled={onOpenActionHandled} />
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
                {outcome.code === 'NOT_FOUND' ? STATUS_TAG.notRegistered : STATUS_TAG.grace}
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
                    {STATUS_TAG.subdomainError}
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
                      {STATUS_TAG.parent}
                    </span>
                  </div>
                </div>
                <AnswerBlock result={outcome.parent} />
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
                  {STATUS_TAG.alarm}
                </span>
              </div>
            </div>
            <div className="reserved-info-box">
              <p className="reserved-text">{alarmBody(outcome.code)}</p>
            </div>
            {/* Which party said what, open, because there is no answer on this
                card to weigh it against (states doc §2). */}
            <QuorumReplies replies={outcome.replies} tone="alarm" />
            {/* The resolver's own message, quiet: the alarm is the headline
                and the rows above are what a user can act on. */}
            <p className="note">{outcome.message}</p>
          </div>
        </RailCard>
      )

    case 'unreachable':
      return (
        <RailCard tier="plain">
          <div className="reserved-card-premium">
            <div className="reserved-header">
              <div className="available-title-row">
                <h2 className="result-name">{registryHeading()}</h2>
                <span className="taken-status-tag">
                  <span className="taken-dot" aria-hidden="true" />
                  {STATUS_TAG.unreachable}
                </span>
              </div>
            </div>
            <div className="reserved-info-box">
              <p className="reserved-text">{unreachableLine()}</p>
            </div>
            {/* Quiet, never alarm vocabulary: nobody disagreed, one party did
                not answer, and the card says which (§5 rule 3). */}
            <QuorumReplies replies={outcome.replies} tone="quiet" />
          </div>
        </RailCard>
      )

    // Depth, never alarm: the change is real and one resolver has not seen
    // it yet. Same tier as a proof pending.
    case 'propagating':
      return (
        <RailCard tier="depth">
          <div className="reserved-card-premium">
            <div className="reserved-header">
              <div className="available-title-row">
                <TitleName name={outcome.query} />
                <span className="taken-status-tag">
                  <span className="taken-dot" aria-hidden="true" />
                  {STATUS_TAG.propagating}
                </span>
              </div>
            </div>
            <div className="reserved-info-box">
              <p className="reserved-text">{propagatingLine()}</p>
            </div>
            <p className="verify verify-depth verify-head" style={{ marginTop: '12px' }}>
              <ClockIcon />
              <span>{propagatingRetryLine(retrying)}</span>
            </p>
            <QuorumReplies replies={outcome.replies} tone="quiet" />
          </div>
        </RailCard>
      )
  }
}
