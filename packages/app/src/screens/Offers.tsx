import { getOffers } from '../lib/api'
import { approxDate, ellipsizeAddress, formatApproxDate, lunaToNim } from '../lib/format'
import { apiBase } from '../lib/nns'
import { useAsync } from '../lib/useAsync'
import { custodialWarning, sendsDisabledLine, unreachableLine } from '../lib/wording'
import { EmptyState, Identicon, NameText, Spinner } from '../components/ui'

export function OffersScreen({ onOpen }: { onOpen: (name: string) => void }) {
  const open = useAsync(() => getOffers(apiBase()), [])

  if (open.status === 'loading' || open.status === 'idle') {
    return (
      <div className="screen">
        <Spinner />
      </div>
    )
  }
  if (open.status === 'error') {
    return (
      <div className="screen">
        <p className="field-error">{unreachableLine()}</p>
      </div>
    )
  }

  const { offers, height } = open.value
  const nowMs = Date.now()

  if (offers.length === 0) {
    return (
      <div className="screen">
        <EmptyState title="Nothing for sale" body="Owners list names here. When one is listed, this is where it shows." />
      </div>
    )
  }

  return (
    <div className="screen">
      <ul className="name-list">
        {offers.map((offer) => (
          <li key={offer.name}>
            <button type="button" className="name-row offer-row" onClick={() => onOpen(offer.name)}>
              <span className="name-row-name">
                <NameText>{offer.name}</NameText>
              </span>
              <span className="offer-price">{lunaToNim(offer.price)} NIM</span>
              <span className="offer-seller">
                <Identicon address={offer.seller} size={24} />
                <span className="nns-name">{ellipsizeAddress(offer.seller)}</span>
              </span>
              <span className="offer-until">until {formatApproxDate(approxDate(offer.expiryHeight, height, nowMs))}</span>
            </button>
          </li>
        ))}
      </ul>
      {/* §8.5 #10's wording ships with the listing; the buy flow itself is send-layer work. */}
      <p className="note note-info">{custodialWarning()}</p>
      <p className="note note-info">{sendsDisabledLine()}</p>
    </div>
  )
}
