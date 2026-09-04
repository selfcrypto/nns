import type { ResolveResult, ResolveWarning } from '@nns/resolver'
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
  resolverIdentityLine,
  standingBidLine,
  verifiedByLine,
} from '../lib/wording'
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
 */
function ResolverList({ quorum }: { quorum: ResolveResult['quorum'] }) {
  if (quorum.resolvers.length === 0) return null
  return (
    <ul className="verify-resolvers">
      {quorum.resolvers.map((resolver) => (
        <li key={resolver.url}>{resolverIdentityLine(resolver)}</li>
      ))}
    </ul>
  )
}

/** The one line §8.5 #6 and the resolver README fix the wording of. */
export function VerificationLine({ result }: { result: ResolveResult }) {
  switch (result.verification) {
    case 'PROVEN':
      return (
        <div className="verify verify-proven">
          <p>{verifiedByLine(result.quorum)}</p>
          <ResolverList quorum={result.quorum} />
        </div>
      )
    case 'PROOF_PENDING':
      return <p className="verify verify-depth">{proofPendingLine()}</p>
    case 'DELEGATED':
      return (
        <div className="verify verify-delegated">
          <Badge tone="delegated">{delegatedLine(result.name)}</Badge>
          <p className="verify-note">{delegatedExplainer(result.name)}</p>
        </div>
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
export function Overlays({ info, nowMs }: { info: NameInfo; nowMs: number }) {
  const { transfer, offer, auction } = info.pending
  if (transfer === null && offer === null && auction === null) return null
  return (
    <div className="overlays">
      {transfer !== null && (
        <p className="overlay">
          {pendingTransferLine(
            ellipsizeAddress(transfer.newOwner),
            formatApproxDate(approxDate(transfer.effectiveHeight, info.height, nowMs)),
          )}
        </p>
      )}
      {offer !== null && <p className="overlay">{forSaleLine(lunaToNim(offer.price))}</p>}
      {auction !== null && (
        <p className="overlay">
          {auctionLine(lunaToNim(auction.startingPrice), formatApproxDate(approxDate(auction.endHeight, info.height, nowMs)))}{' '}
          {auction.bidder === null ? noBidsLine() : standingBidLine(lunaToNim(auction.bid), ellipsizeAddress(auction.bidder))}{' '}
          {minimumBidLine(lunaToNim(auction.minimumBid))}
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
