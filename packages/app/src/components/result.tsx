import { useEffect, useId, useState } from 'react'
import type { ResolveResult, ResolveWarning, ResolverReply } from '@nimiqnames/resolver'
import type { NameInfo } from '../lib/api'
import { displayAddress, ellipsizeAddress, formatApproxWhen, formatApproxIn, approxDate, lunaToNim } from '../lib/format'
import {
  RENDERED_ELSEWHERE,
  WARNING_TEXT,
  WARNING_TONE,
  auctionLine,
  copiedLabel,
  copyAddressLabel,
  copyFailedLine,
  delegatedExplainer,
  delegatedLine,
  feeChangeLine,
  forSaleLine,
  minimumBidLine,
  noBidsLine,
  pendingTransferLine,
  proofPendingLine,
  resolverLatency,
  resolverParty,
  standingBidLine,
  verifiedByLine,
  verifiedHint,
} from '../lib/wording'
import { type CopyOutcome, writeClipboard } from '../lib/clipboard'
import { Hint } from './Hint'
import { CheckIcon, ChevronIcon, ClockIcon, CopyIcon, TickIcon } from './icons'
import { Badge, Identicon, NameText, type RailTier } from './ui'

export const tierOf = (result: ResolveResult): RailTier => {
  switch (result.verification) {
    case 'PROVEN':
      return 'proven'
    case 'PROOF_PENDING':
      return 'depth'
    case 'DELEGATED':
      return 'delegated'
  }
}

/**
 * Who agreed, by name **and API URL**. The count says how many parties the
 * answer rests on; only the URL says which, and a user who wants to check one
 * has to be able to see where it lives.
 *
 * Behind a disclosure, closed by default: at the two resolvers of today it is
 * two lines, at the six or eight of a grown quorum it is the whole card, and
 * the list is evidence for the count rather than the statement itself (Kike,
 * 2026-09-11). The count line is the disclosure, so the evidence is one tap
 * away and never more than that — §5 wording rule 1.
 */
function ProvenVerification({ result }: { result: ResolveResult }) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const { resolvers } = result.quorum
  const line = <span>{verifiedByLine(result.quorum)}</span>
  return (
    <div className="verify verify-proven">
      <p className="verify-head">
        {resolvers.length === 0 ? (
          <>
            <CheckIcon />
            {line}
          </>
        ) : (
          <button
            type="button"
            className="verify-toggle"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen(!open)}
          >
            <CheckIcon />
            {line}
            <ChevronIcon />
          </button>
        )}
        <Hint>{verifiedHint()}</Hint>
      </p>
      {open && (
        <ul className="verify-parties" id={listId}>
          {resolvers.map((resolver) => {
            const party = resolverParty(resolver)
            return (
              <li key={resolver.url}>
                <span className="party-dot" aria-hidden="true" />
                {/* One line per party: the endpoint, and what it cost to ask
                    it. The configured name only joins when the URL does not
                    already carry it — `resolverParty` holds that rule. */}
                <span className="party-name">{party.primary}</span>
                <span className="party-ms">{resolverLatency(resolver.ms)}</span>
                {party.secondary !== null && <span className="party-detail">{party.secondary}</span>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * What each resolver said, on the cards that have no answer to show:
 * `QUORUM_DISAGREEMENT`, `QUORUM_ROOT_MISMATCH`, `QUORUM_UNMET` and
 * `QUORUM_LAGGING` (states doc §2 — name the party, never only the verdict).
 *
 * **Open, because the answer is missing.** The agreeing list is closed: it is
 * evidence for a statement the user already has. Here the statement is that
 * there is nothing to act on, and why is the only thing on the card worth
 * reading, so a tap between the user and it is a tap too many.
 *
 * `answer` is the resolver package's own one-line summary and is rendered
 * verbatim. Paraphrasing it would substitute the app's word for the party's,
 * which is the one thing this list exists to stop.
 */
export function QuorumReplies({ replies, tone }: { replies: readonly ResolverReply[]; tone: 'alarm' | 'quiet' }) {
  if (replies.length === 0) return null
  return (
    <ul className={`verify-parties verify-parties-${tone}`}>
      {replies.map((reply, index) => (
        <li key={`${reply.resolver}-${index}`}>
          <span className="party-dot" aria-hidden="true" />
          <span className="party-name">{reply.resolver}</span>
          <span className="party-detail">{reply.answer}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The address and who vouched for it, as **one object with two compartments**
 * (Kike, 2026-09-15: *"place them inside a bubble or a div, properly
 * aligned"*). They were two siblings with three different left edges, and the
 * verification read as a loose caption rather than as the provenance of the
 * address above it.
 *
 * `--box-pad` is what lets the foot bleed to the box's edges without knowing
 * which box it is in: Pay's recipient card sets its own and gets the same
 * divider.
 */
export function AnswerBlock({ result }: { result: ResolveResult }) {
  return (
    <div className="answer-block">
      <AddressRow address={result.address} full />
      <div className="answer-foot">
        <VerificationLine result={result} />
      </div>
    </div>
  )
}

/** The one line §8.5 #6 and the resolver README fix the wording of. */
export function VerificationLine({ result }: { result: ResolveResult }) {
  switch (result.verification) {
    case 'PROVEN':
      return <ProvenVerification result={result} />
    case 'PROOF_PENDING':
      return (
        <p className="verify verify-depth verify-head">
          <ClockIcon />
          <span>{proofPendingLine()}</span>
        </p>
      )
    case 'DELEGATED': {
      // The badge names the host and the hint names the parent: the host is
      // who answered, the parent is who delegated, and only the second is
      // proven.
      const host = result.delegate?.host ?? null
      return (
        <p className="verify verify-delegated verify-head">
          <Badge tone="delegated">{delegatedLine(result.name, host)}</Badge>
          <Hint>{delegatedExplainer(result.name, host)}</Hint>
        </p>
      )
    }
  }
}

/** Non-halting notes, tone-mapped; codes a dedicated element already renders are filtered. */
export function WarningNotes({ warnings }: { warnings: readonly ResolveWarning[] }) {
  const shown = warnings.filter((warning) => !RENDERED_ELSEWHERE.has(warning.code))
  if (shown.length === 0) return null
  return (
    <ul className="notes">
      {shown.map((warning) => (
        <li key={warning.code} className={`note note-${WARNING_TONE[warning.code]}`}>
          {WARNING_TEXT[warning.code]}
        </li>
      ))}
    </ul>
  )
}

/**
 * The address being answered, with its identicon — what will actually be
 * paid, and the whole row is the copy control.
 *
 * Copying is offered here and not on every address the app draws (Kike,
 * 2026-09-16: *"I don't know if add a copy option always on every case"*).
 * The line is whether the address is the **object** of the screen or a word
 * inside something else: this row and the Inbox's thread header are objects,
 * while the My Names tiles, the identity rows and the conversation list are
 * labels on buttons that already do a different thing, and the seller, the
 * bidder and a pending transfer's recipient are words in sentences. A copy
 * control nested in a button is invalid and, on a thumb in Pay's WebView,
 * puts two targets in one row. A hover highlight that means "this copies"
 * only half the time means nothing, so it is spent where the copy is a task
 * somebody actually has: the address they are about to pay, on its way to an
 * explorer or a message.
 *
 * What lands on the clipboard is always `displayAddress` — the full spaced
 * form, the spelling the wallet and the explorer show, whatever this row has
 * room to draw.
 */
export function AddressRow({ address, full = false }: { address: string; full?: boolean }) {
  const [copied, setCopied] = useState<CopyOutcome | null>(null)
  useEffect(() => {
    if (copied === null) return
    const timer = setTimeout(() => setCopied(null), 2_500)
    return () => clearTimeout(timer)
  }, [copied])

  const label = copied === 'ok' ? copiedLabel() : copyAddressLabel()
  return (
    <button
      type="button"
      className={`address-row address-copy${copied === null ? '' : ` is-${copied}`}`}
      onClick={() => void writeClipboard(displayAddress(address)).then(setCopied)}
      title={label}
      aria-label={label}
    >
      <Identicon address={address} />
      <span className="address nns-name">{full ? displayAddress(address) : ellipsizeAddress(address)}</span>
      <span className="address-copy-mark" aria-hidden>
        {copied === 'ok' ? (
          <>
            <TickIcon />
            {copiedLabel()}
          </>
        ) : copied === 'failed' ? (
          copyFailedLine()
        ) : (
          <CopyIcon />
        )}
      </span>
    </button>
  )
}

/** §1 overlays on a registered name: pending transfer, open offer, open auction. */
export function Overlays({
  info,
  nowMs,
  hideMarketplace = false,
}: {
  info: NameInfo
  nowMs: number
  hideMarketplace?: boolean
}) {
  const { transfer, offer, auction } = info.pending
  if (transfer === null && (hideMarketplace || (offer === null && auction === null))) return null
  return (
    <div className="overlays">
      {transfer !== null && (
        <p className="overlay overlay-transfer">
          {pendingTransferLine(ellipsizeAddress(transfer.newOwner), formatApproxIn(transfer.effectiveHeight - info.height))}
        </p>
      )}
      {!hideMarketplace && offer !== null && <p className="overlay overlay-offer">{forSaleLine(lunaToNim(offer.price))}</p>}
      {!hideMarketplace && auction !== null && (
        <p className="overlay overlay-auction">
          <span className="overlay-line">
            {auctionLine(lunaToNim(auction.startingPrice), formatApproxWhen(approxDate(auction.endHeight, info.height, nowMs), nowMs))}
          </span>
          <span className="overlay-line">
            {auction.bidder === null ? noBidsLine() : standingBidLine(lunaToNim(auction.bid), ellipsizeAddress(auction.bidder))}{' '}
            {minimumBidLine(lunaToNim(auction.minimumBid))}
          </span>
        </p>
      )}
    </div>
  )
}

export function FeeChangeNote({ effectiveHeight, head, nowMs }: { effectiveHeight: number; head: number; nowMs: number }) {
  return <p className="note note-info">{feeChangeLine(formatApproxWhen(approxDate(effectiveHeight, head, nowMs), nowMs))}</p>
}

export function TitleName({ name }: { name: string }) {
  return (
    <h2 className="result-name">
      <NameText>{name}</NameText>
    </h2>
  )
}
