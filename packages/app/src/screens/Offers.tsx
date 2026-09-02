/**
 * **Market** — every name for sale: open offers (`O`) and open auctions
 * (`A`, r28) in one list, because a buyer is looking for a name, not for a
 * mechanism. Both come from the same snapshot height only when both fetches
 * happen to land on it; each row renders its own dates off the height its
 * list carried, so the two can never be paired wrong.
 *
 * Row → the name's card in Buy, where `buy` or `bid` — never both, state
 * decides (§6 `A`) — is the action offered.
 */

import { getAuctions, getOffers, type ApiAuction, type ApiOffer } from '../lib/api'
import { approxDate, ellipsizeAddress, formatApproxDate, lunaToNim } from '../lib/format'
import { apiBase } from '../lib/nns'
import { useAsync } from '../lib/useAsync'
import {
  auctionBadge,
  auctionEndsLine,
  custodialWarning,
  expiryUntilLine,
  minimumBidLine,
  noBidsLine,
  offersEmptyBody,
  offersEmptyTitle,
  reserveLine,
  standingBidLine,
  unreachableLine,
} from '../lib/wording'
import { Badge, EmptyState, Identicon, NameText, Spinner } from '../components/ui'

interface Market {
  readonly offers: readonly ApiOffer[]
  readonly offersHeight: number
  readonly auctions: readonly ApiAuction[]
  readonly auctionsHeight: number
}

async function loadMarket(base: string): Promise<Market> {
  const [open, running] = await Promise.all([getOffers(base), getAuctions(base)])
  return { offers: open.offers, offersHeight: open.height, auctions: running.auctions, auctionsHeight: running.height }
}

function OfferRow({ offer, height, nowMs, onOpen }: { offer: ApiOffer; height: number; nowMs: number; onOpen: (name: string) => void }) {
  return (
    <li>
      <button type="button" className="name-row offer-row" onClick={() => onOpen(offer.name)}>
        <span className="name-row-name">
          <NameText>{offer.name}</NameText>
        </span>
        <span className="offer-price">{lunaToNim(offer.price)} NIM</span>
        <span className="offer-seller">
          <Identicon address={offer.seller} size={24} />
          <span className="nns-name">{ellipsizeAddress(offer.seller)}</span>
        </span>
        <span className="offer-until">{expiryUntilLine(formatApproxDate(approxDate(offer.expiryHeight, height, nowMs)))}</span>
      </button>
    </li>
  )
}

/**
 * The standing bid where one stands, the reserve where none does — the
 * amount a bidder has to beat either way — with the minimum next bid the API
 * computed through `core.requiredBid`, and the end as an ≈ date.
 */
function AuctionRow({ auction, height, nowMs, onOpen }: { auction: ApiAuction; height: number; nowMs: number; onOpen: (name: string) => void }) {
  const standing = auction.bidder === null
  return (
    <li>
      <button type="button" className="name-row offer-row auction-row" onClick={() => onOpen(auction.name)}>
        <span className="name-row-name">
          <NameText>{auction.name}</NameText>
          <Badge tone="info">{auctionBadge()}</Badge>
        </span>
        <span className="offer-price">{standing ? reserveLine(lunaToNim(auction.reserve)) : `${lunaToNim(auction.bid)} NIM`}</span>
        <span className="offer-seller">
          <Identicon address={auction.seller} size={24} />
          <span className="nns-name">{ellipsizeAddress(auction.seller)}</span>
        </span>
        <span className="offer-next">
          {standing ? noBidsLine() : standingBidLine(lunaToNim(auction.bid), ellipsizeAddress(auction.bidder ?? ''))}{' '}
          {minimumBidLine(lunaToNim(auction.minimumBid))}
        </span>
        <span className="offer-until">{auctionEndsLine(formatApproxDate(approxDate(auction.endHeight, height, nowMs)))}</span>
      </button>
    </li>
  )
}

export function OffersScreen({ onOpen }: { onOpen: (name: string) => void }) {
  const market = useAsync(() => loadMarket(apiBase()), [])

  if (market.status === 'loading' || market.status === 'idle') {
    return (
      <div className="screen">
        <Spinner />
      </div>
    )
  }
  if (market.status === 'error') {
    return (
      <div className="screen">
        <p className="field-error">{unreachableLine()}</p>
      </div>
    )
  }

  const { offers, offersHeight, auctions, auctionsHeight } = market.value
  const nowMs = Date.now()

  if (offers.length === 0 && auctions.length === 0) {
    return (
      <div className="screen">
        <EmptyState title={offersEmptyTitle()} body={offersEmptyBody()} />
      </div>
    )
  }

  return (
    <div className="screen">
      <ul className="name-list">
        {offers.map((offer) => (
          <OfferRow key={`offer:${offer.name}`} offer={offer} height={offersHeight} nowMs={nowMs} onOpen={onOpen} />
        ))}
        {auctions.map((auction) => (
          <AuctionRow key={`auction:${auction.name}`} auction={auction} height={auctionsHeight} nowMs={nowMs} onOpen={onOpen} />
        ))}
      </ul>
      {/* §8.5 #10's wording ships with the listing; the checkbox-gated version guards the buy and bid sheets themselves. */}
      <p className="note note-info">{custodialWarning()}</p>
    </div>
  )
}
