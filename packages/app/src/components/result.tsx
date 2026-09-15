import { useId, useState } from 'react'
import type { ResolveResult, ResolveWarning } from '@nimiqnames/resolver'
import type { NameInfo } from '../lib/api'
import { displayAddress, ellipsizeAddress, formatApproxDate, approxDate, lunaToNim } from '../lib/format'
import {
  RENDERED_ELSEWHERE,
  WARNING_TEXT,
  WARNING_TONE,
  auctionLine,
  delegatedExplainer,
  delegatedLine,
  feeChangeLine,
  forSaleLine,
  minimumBidLine,
  noBidsLine,
  pendingTransferLine,
  proofPendingLine,
  resolverUrlShown,
  standingBidLine,
  verifiedByLine,
  verifiedHint,
} from '../lib/wording'
import { Hint } from './Hint'
import { CheckIcon, ChevronIcon, ClockIcon } from './icons'
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
        <CheckIcon />
        {resolvers.length === 0 ? (
          line
        ) : (
          <button
            type="button"
            className="verify-toggle"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen(!open)}
          >
            {line}
            <ChevronIcon />
          </button>
        )}
        <Hint>{verifiedHint()}</Hint>
      </p>
      {open && (
        <ul className="verify-resolvers" id={listId}>
          {resolvers.map((resolver) => (
            <li key={resolver.url}>
              <span className="resolver-pill">{resolver.name}</span>{' '}
              {/* No separator between the two: on a phone the endpoint drops to its
                  own line, and a dash or dot then leads that line as debris. The
                  pill's own background is the separation at every width. */}
              <span className="resolver-url">{resolverUrlShown(resolver.url)}</span>
            </li>
          ))}
        </ul>
      )}
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
    case 'DELEGATED':
      return (
        <p className="verify verify-delegated verify-head">
          <Badge tone="delegated">{delegatedLine(result.name)}</Badge>
          <Hint>{delegatedExplainer(result.name, result.delegate?.host ?? null)}</Hint>
        </p>
      )
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

/** The address being answered, with its identicon — what will actually be paid. */
export function AddressRow({ address, full = false }: { address: string; full?: boolean }) {
  return (
    <div className="address-row">
      <Identicon address={address} />
      <span className="address nns-name">{full ? displayAddress(address) : ellipsizeAddress(address)}</span>
    </div>
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
          {pendingTransferLine(
            ellipsizeAddress(transfer.newOwner),
            formatApproxDate(approxDate(transfer.effectiveHeight, info.height, nowMs)),
          )}
        </p>
      )}
      {!hideMarketplace && offer !== null && <p className="overlay overlay-offer">{forSaleLine(lunaToNim(offer.price))}</p>}
      {!hideMarketplace && auction !== null && (
        <p className="overlay overlay-auction">
          <span className="overlay-line">
            {auctionLine(lunaToNim(auction.startingPrice), formatApproxDate(approxDate(auction.endHeight, info.height, nowMs)))}
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
  return <p className="note note-info">{feeChangeLine(formatApproxDate(approxDate(effectiveHeight, head, nowMs)))}</p>
}

export function TitleName({ name }: { name: string }) {
  return (
    <h2 className="result-name">
      <NameText>{name}</NameText>
    </h2>
  )
}
