/**
 * **Market** — every name for sale: open offers (`O`) and open auctions
 * (`A`, r28) in one list, a buyer looking for a name rather than a mechanism.
 * *Buy* or *Bid* opens the sheet under the listing — never both, because
 * state decides which a `B` is (§6 `A`) — with the name's proof above it: the
 * same address, verification line and pin check the Buy card shows, so nobody
 * pays for a name they have not seen verified. Each list renders dates off
 * its own height, because the two endpoints answer from different blocks.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { getAuctions, getOffers, type ApiAuction, type ApiOffer } from '../lib/api'
import { approxDate, ellipsizeAddress, formatApproxDate, lunaToNim } from '../lib/format'
import { apiBase } from '../lib/nns'
import { search } from '../lib/search'
import { nameView, signerFor } from '../lib/states'
import { useAsync } from '../lib/useAsync'
import type { Wallet } from '../lib/wallet'
import { ActionSheet } from '../components/ActionSheet'
import { BurnFigures } from '../components/BurnFigures'
import { PinCheck } from '../components/PinCheck'
import { AddressRow, VerificationLine } from '../components/result'
import {
  auctionEndsLine,
  custodialWarning,
  expiryUntilLine,
  minimumBidLine,
  noBidsLine,
  startingPriceLine,
  standingBidLine,
  unreachableLine,
} from '../lib/wording'
import { Identicon, NameText, Spinner } from '../components/ui'
import styles from './market.module.css'

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

function MarketActionSheetWrapper({
  name,
  action,
  wallet,
  onConnect,
  onClose,
  onChanged,
}: {
  name: string
  action: 'buy' | 'bid'
  wallet: Wallet | null
  onConnect?: (() => void) | null | undefined
  onClose: () => void
  onChanged: () => void
}) {
  // The same lookup the Buy card runs — resolve, proof, record — not a bare
  // `/name`: the sheet has to show who verified the name before taking money.
  const outcome = useAsync(() => search(name), [name])

  if (wallet === null) {
    return (
      <div className="sheet">
        <div className="sheet-header">
          <span className="sheet-title">{action === 'buy' ? 'Buy' : 'Bid on'} {name}</span>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <p className="sheet-current">Connect your wallet to {action === 'buy' ? 'buy' : 'place a bid on'} {name}.</p>
        {onConnect && (
          <button type="button" className="action-go action-connect" onClick={onConnect} style={{ width: '100%', marginTop: '8px' }}>
            Connect Wallet
          </button>
        )}
      </div>
    )
  }

  if (outcome.status === 'loading' || outcome.status === 'idle') {
    return (
      <div className="sheet">
        <div className="sheet-header">
          <span className="sheet-title">{action === 'buy' ? 'Buy' : 'Bid on'} {name}</span>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div className="sheet-loading">
          <Spinner />
        </div>
      </div>
    )
  }

  if (outcome.status === 'error' || outcome.value.kind !== 'resolved' || outcome.value.info === null) {
    return (
      <div className="sheet">
        <div className="sheet-header">
          <span className="sheet-title">{action === 'buy' ? 'Buy' : 'Bid on'} {name}</span>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <p className="field-error">Could not load details for {name} — try again.</p>
      </div>
    )
  }

  const { result, info } = outcome.value
  const viewers = wallet.identity.addresses
  const signer = signerFor(action, nameView(name, info, 'registered'), viewers) ?? viewers[0] ?? ''

  return (
    <>
      <div className="market-proof">
        <PinCheck query={result.query} address={result.address} />
        <div className="address-card-wrap">
          <AddressRow address={result.address} full />
        </div>
        <div className="resolved-meta-section">
          <VerificationLine result={result} />
        </div>
      </div>
      <ActionSheet
        action={action}
        name={name}
        info={info}
        signer={signer}
        viewers={viewers}
        wallet={wallet}
        onChanged={onChanged}
        onClose={onClose}
      />
    </>
  )
}

function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

function ArrowRightIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  )
}

function OfferCard({
  offer,
  height,
  nowMs,
  isOpen,
  onToggle,
  children,
}: {
  offer: ApiOffer
  height: number
  nowMs: number
  isOpen: boolean
  onToggle: () => void
  children?: React.ReactNode
}) {
  const cardRef = useRef<HTMLLIElement | null>(null)

  useEffect(() => {
    if (isOpen && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [isOpen])

  return (
    <li ref={cardRef} className={`${styles.marketCard} ${isOpen ? styles.marketCardOpen : ''}`}>
      <div className={styles.cardTrigger} onClick={onToggle} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggle() }}>
        <div className={styles.cardHeader}>
          <div className={styles.cardNameArea}>
            <Identicon address={offer.seller} size={28} />
            <span className={styles.cardName}>
              <NameText>{offer.name}</NameText>
            </span>
          </div>
          <span className={styles.tagSale}>
            <span className={styles.statusDot} aria-hidden="true" />
            Buy Now
          </span>
        </div>

        <div className={styles.cardGrid}>
          <div className={styles.cardPriceGroup}>
            <span className={styles.cardPriceLabel}>Fixed Price</span>
            <div className={styles.cardPriceValue}>
              {lunaToNim(offer.price)}
              <span className={styles.cardPriceUnit}>NIM</span>
            </div>
          </div>
          <button
            type="button"
            className={`${styles.cardActionBtn} ${isOpen ? styles.cardActionBtnOpen : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
          >
            {isOpen ? 'Close' : 'Buy Now'}
            {!isOpen && <ArrowRightIcon />}
          </button>
        </div>

        <div className={styles.cardMeta}>
          <div className={styles.metaItem}>
            <span className={styles.metaIcon}>
              <Identicon address={offer.seller} size={16} />
            </span>
            <span>Sold by <strong className="nns-name">{ellipsizeAddress(offer.seller)}</strong></span>
          </div>
          <div className={styles.metaItem}>
            <span className={styles.metaIcon}><ClockIcon /></span>
            <span>{expiryUntilLine(formatApproxDate(approxDate(offer.expiryHeight, height, nowMs)))}</span>
          </div>
        </div>
      </div>
      {isOpen && <div className={styles.dropdownWrap}>{children}</div>}
    </li>
  )
}

function AuctionCard({
  auction,
  height,
  nowMs,
  isOpen,
  onToggle,
  children,
}: {
  auction: ApiAuction
  height: number
  nowMs: number
  isOpen: boolean
  onToggle: () => void
  children?: React.ReactNode
}) {
  const cardRef = useRef<HTMLLIElement | null>(null)

  useEffect(() => {
    if (isOpen && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [isOpen])

  const standing = auction.bidder === null

  return (
    <li ref={cardRef} className={`${styles.marketCard} ${isOpen ? styles.marketCardOpen : ''}`}>
      <div className={styles.cardTrigger} onClick={onToggle} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggle() }}>
        <div className={styles.cardHeader}>
          <div className={styles.cardNameArea}>
            <Identicon address={auction.seller} size={28} />
            <span className={styles.cardName}>
              <NameText>{auction.name}</NameText>
            </span>
          </div>
          <span className={styles.tagAuction}>
            <span className={styles.statusDot} aria-hidden="true" />
            Live Auction
          </span>
        </div>

        <div className={styles.cardGrid}>
          <div className={styles.cardPriceGroup}>
            <span className={styles.cardPriceLabel}>{standing ? 'Starting Price' : 'Standing Bid'}</span>
            <div className={styles.cardPriceValue}>
              {standing ? lunaToNim(auction.startingPrice) : lunaToNim(auction.bid)}
              <span className={styles.cardPriceUnit}>NIM</span>
            </div>
            <span className={styles.cardAuctionNext}>
              {standing ? noBidsLine() : standingBidLine(lunaToNim(auction.bid), ellipsizeAddress(auction.bidder ?? ''))} · {minimumBidLine(lunaToNim(auction.minimumBid))}
            </span>
          </div>
          <button
            type="button"
            className={`${styles.cardActionBtn} ${isOpen ? styles.cardActionBtnOpen : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
          >
            {isOpen ? 'Close' : 'Place Bid'}
            {!isOpen && <ArrowRightIcon />}
          </button>
        </div>

        <div className={styles.cardMeta}>
          <div className={styles.metaItem}>
            <span className={styles.metaIcon}>
              <Identicon address={auction.seller} size={16} />
            </span>
            <span>Listed by <strong className="nns-name">{ellipsizeAddress(auction.seller)}</strong></span>
          </div>
          <div className={styles.metaItem}>
            <span className={styles.metaIcon}><ClockIcon /></span>
            <span>{auctionEndsLine(formatApproxDate(approxDate(auction.endHeight, height, nowMs)))}</span>
          </div>
        </div>
      </div>
      {isOpen && <div className={styles.dropdownWrap}>{children}</div>}
    </li>
  )
}

type FilterTab = 'all' | 'offers' | 'auctions'

export function OffersScreen({
  wallet,
  onConnect,
  initialOpenName,
  onClearInitial,
}: {
  wallet?: Wallet | null | undefined
  onConnect?: (() => void) | null | undefined
  initialOpenName?: string | null | undefined
  onClearInitial?: (() => void) | undefined
}) {
  const [nonce, setNonce] = useState(0)
  const market = useAsync(() => loadMarket(apiBase()), [nonce])
  const [activeItem, setActiveItem] = useState<{ readonly name: string; readonly action: 'buy' | 'bid' } | null>(null)
  const [tab, setTab] = useState<FilterTab>('all')
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    if (initialOpenName && market.status === 'done') {
      const isAuction = market.value.auctions.some((a) => a.name === initialOpenName)
      setActiveItem({
        name: initialOpenName,
        action: isAuction ? 'bid' : 'buy',
      })
      onClearInitial?.()
    }
  }, [initialOpenName, market.status])

  const reload = () => {
    setNonce((n) => n + 1)
    setActiveItem(null)
  }

  const queryTrimmed = searchQuery.trim().toLowerCase()

  const filteredOffers = useMemo(() => {
    if (market.status !== 'done') return []
    return market.value.offers.filter((o) => queryTrimmed === '' || o.name.toLowerCase().includes(queryTrimmed))
  }, [market, queryTrimmed])

  const filteredAuctions = useMemo(() => {
    if (market.status !== 'done') return []
    return market.value.auctions.filter((a) => queryTrimmed === '' || a.name.toLowerCase().includes(queryTrimmed))
  }, [market, queryTrimmed])

  if (market.status === 'loading' || market.status === 'idle') {
    return (
      <div className={`screen ${styles.lightThemeWrapper}`}>
        <div className={styles.heroSection}>
          <div className={styles.heroContent} style={{ paddingTop: '80px' }}>
            <Spinner />
          </div>
        </div>
      </div>
    )
  }

  if (market.status === 'error') {
    return (
      <div className={`screen ${styles.lightThemeWrapper}`}>
        <div className={styles.heroSection}>
          <div className={styles.heroContent}>
            <div className={styles.marketPanel}>
              <p className="field-error">{unreachableLine()}</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const { offers, offersHeight, auctions, auctionsHeight } = market.value
  const nowMs = Date.now()

  const totalOffersCount = offers.length
  const totalAuctionsCount = auctions.length
  const totalListings = totalOffersCount + totalAuctionsCount

  const showOffers = tab === 'all' || tab === 'offers'
  const showAuctions = tab === 'all' || tab === 'auctions'

  const displayedOffers = showOffers ? filteredOffers : []
  const displayedAuctions = showAuctions ? filteredAuctions : []
  const totalDisplayed = displayedOffers.length + displayedAuctions.length

  return (
    <div className={`screen ${styles.lightThemeWrapper}`}>
      <div className={styles.heroSection}>
        <div className={styles.heroContent}>
          {/* Header */}
          <div className={styles.marketHeader}>
            <h1 className={styles.marketTitle}>Marketplace</h1>
            <p className={styles.marketSubtitle}>
              Acquire registered NNS names or place bids on live auctions.
            </p>
          </div>

          {/* Main Glassmorphism Panel */}
          <div className={styles.marketPanel}>
            {/* Toolbar */}
            <div className={styles.toolbar}>
              <div className={styles.searchBox}>
                <div className={styles.searchIcon}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </div>
                <input
                  type="text"
                  className={styles.searchInput}
                  placeholder="Filter listings by name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  aria-label="Filter listings by name"
                />
                {searchQuery.trim() !== '' && (
                  <button
                    type="button"
                    className={styles.searchClear}
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear filter"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>

              <div className={styles.filterPills}>
                <button
                  type="button"
                  className={`${styles.filterBtn} ${tab === 'all' ? styles.filterBtnActive : ''}`}
                  onClick={() => setTab('all')}
                >
                  All
                  <span className={styles.filterBadge}>{totalListings}</span>
                </button>
                <button
                  type="button"
                  className={`${styles.filterBtn} ${tab === 'offers' ? styles.filterBtnActive : ''}`}
                  onClick={() => setTab('offers')}
                >
                  Buy Now
                  <span className={styles.filterBadge}>{totalOffersCount}</span>
                </button>
                <button
                  type="button"
                  className={`${styles.filterBtn} ${tab === 'auctions' ? styles.filterBtnActive : ''}`}
                  onClick={() => setTab('auctions')}
                >
                  Auctions
                  <span className={styles.filterBadge}>{totalAuctionsCount}</span>
                </button>
              </div>
            </div>

            {/* Content List or Empty State */}
            {totalListings === 0 ? (
              <div className={styles.emptyCard}>
                <div className={styles.emptyIcon}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
                  </svg>
                </div>
                <h3 className={styles.emptyTitle}>No names listed yet</h3>
                <p className={styles.emptyBody}>
                  There are currently no names listed for direct sale or active auction on the marketplace.
                </p>
              </div>
            ) : totalDisplayed === 0 ? (
              <div className={styles.emptyCard}>
                <div className={styles.emptyIcon}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </div>
                <h3 className={styles.emptyTitle}>No matching listings</h3>
                <p className={styles.emptyBody}>
                  No names matched &ldquo;{searchQuery}&rdquo; under the {tab === 'all' ? 'current' : tab === 'offers' ? 'Buy Now' : 'Auctions'} filter.
                </p>
              </div>
            ) : (
              <ul className={styles.cardsList}>
                {displayedOffers.map((offer) => {
                  const isOpen = activeItem?.name === offer.name
                  return (
                    <OfferCard
                      key={`offer:${offer.name}`}
                      offer={offer}
                      height={offersHeight}
                      nowMs={nowMs}
                      isOpen={isOpen}
                      onToggle={() => setActiveItem(isOpen ? null : { name: offer.name, action: 'buy' })}
                    >
                      <MarketActionSheetWrapper
                        name={offer.name}
                        action="buy"
                        wallet={wallet ?? null}
                        onConnect={onConnect ?? null}
                        onClose={() => setActiveItem(null)}
                        onChanged={reload}
                      />
                    </OfferCard>
                  )
                })}
                {displayedAuctions.map((auction) => {
                  const isOpen = activeItem?.name === auction.name
                  return (
                    <AuctionCard
                      key={`auction:${auction.name}`}
                      auction={auction}
                      height={auctionsHeight}
                      nowMs={nowMs}
                      isOpen={isOpen}
                      onToggle={() => setActiveItem(isOpen ? null : { name: auction.name, action: 'bid' })}
                    >
                      <MarketActionSheetWrapper
                        name={auction.name}
                        action="bid"
                        wallet={wallet ?? null}
                        onConnect={onConnect ?? null}
                        onClose={() => setActiveItem(null)}
                        onChanged={reload}
                      />
                    </AuctionCard>
                  )
                })}
              </ul>
            )}

            {/* Custodial Settlement Notice */}
            <div className={styles.custodialBox}>
              <div className={styles.custodialIcon}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              </div>
              <p className={styles.custodialText}>{custodialWarning()}</p>
            </div>

            <BurnFigures />
          </div>

          {/* Trust Bar */}
          <div className={styles.trustBar}>
            <div className={styles.trustItem}>
              <svg className={styles.trustIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
              <span>100% On-Chain Escrow</span>
            </div>
            <span className={styles.trustDot}>•</span>
            <div className={styles.trustItem}>
              <svg className={styles.trustIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
              <span>Direct Settlement</span>
            </div>
            <span className={styles.trustDot}>•</span>
            <div className={styles.trustItem}>
              <svg className={styles.trustIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span>Anti-Sniping Extension</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
