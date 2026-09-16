/**
 * **Market** — every name for sale: open offers (`O`) and open auctions
 * (`A`, r28) in one list, a buyer looking for a name rather than a mechanism.
 * *Buy* or *Bid* opens the sheet under the listing — never both, because
 * state decides which a `B` is (§6 `A`).
 *
 * **The sheet shows no resolved address and no verification badge**, and the
 * resolve still runs: `search()` gates the sale, because a quorum that does
 * not agree comes back as `alarm` and the sheet refuses to open a form. What
 * it proves is the name's *target* — the address the seller points the name
 * at, which the buyer overwrites the moment they own it — and the leaf's
 * `owner` is not in the agreement key, so the badge never spoke to the one
 * question a buyer has: does the seller own this. Rendering it beside
 * *Sold by* printed one address twice, that being the ordinary case of an
 * owner pointing a name at themself (Kike, 2026-09-16; decisions.md, "A
 * verification badge belongs on the answer it verifies"). The §8.5 pin check
 * left for its own reasons the same day.
 *
 * Each list renders dates off its own height, because the two endpoints
 * answer from different blocks.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { getAuctions, getOffers, type ApiAuction, type ApiOffer } from '../lib/api'
import { approxDate, ellipsizeAddress, formatApproxWhen, lunaToNim } from '../lib/format'
import { apiBase } from '../lib/nns'
import { search } from '../lib/search'
import { connectInstead, nameView, signerFor } from '../lib/states'
import { useAsync } from '../lib/useAsync'
import type { Wallet } from '../lib/wallet'
import { ActionSheet } from '../components/ActionSheet'
import { BurnFigures } from '../components/BurnFigures'
import { Hint } from '../components/Hint'
import {
  MARKET_FILTER,
  SCREEN_SUB,
  SCREEN_TITLE,
  auctionEndsLine,
  bidSheetTitle,
  buyNowLabel,
  buySheetTitle,
  clearLabel,
  closeLabel,
  connectToBidLine,
  connectToBuyLine,
  connectWalletLabel,
  marketCustodialHint,
  marketCustodialLine,
  expiryUntilLine,
  fixedPriceLabel,
  forSaleLabel,
  listedByLabel,
  saleLoadFailedLine,
  liveAuctionLabel,
  marketFilterAria,
  marketFilterPlaceholder,
  marketNoMatchLine,
  marketNoMatchTitle,
  minimumBidLine,
  noBidsLine,
  offersEmptyBody,
  offersEmptyTitle,
  placeBidLabel,
  soldByLabel,
  standingBidLabel,
  startingPriceLabel,
  startingPriceLine,
  standingBidLine,
  unreachableLine,
} from '../lib/wording'
import { TrustBar } from '../components/TrustBar'
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

/** The sheet's frame while it has no proof to show: a title and a close. */
function SheetShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="sheet">
      <div className="sheet-header">
        <span className="sheet-title">{title}</span>
        <button type="button" className="sheet-close" onClick={onClose} aria-label={closeLabel()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      {children}
    </div>
  )
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

  const title = action === 'buy' ? buySheetTitle(name) : bidSheetTitle(name)

  // Not "no wallet object" — no *address*. The Hub adapter answers before
  // anybody connects, and on that answer this sheet used to open with an empty
  // signer instead of asking for the wallet (states.ts, `connectInstead`).
  if (wallet === null || connectInstead(wallet, true)) {
    return (
      <SheetShell title={title} onClose={onClose}>
        <p className="sheet-current">{action === 'buy' ? connectToBuyLine(name) : connectToBidLine(name)}</p>
        {onConnect && (
          <button type="button" className="action-go action-connect" onClick={onConnect} style={{ width: '100%', marginTop: '8px' }}>
            {connectWalletLabel()}
          </button>
        )}
      </SheetShell>
    )
  }

  if (outcome.status === 'loading' || outcome.status === 'idle') {
    return (
      <SheetShell title={title} onClose={onClose}>
        <div className="sheet-loading">
          <Spinner />
        </div>
      </SheetShell>
    )
  }

  if (outcome.status === 'error' || outcome.value.kind !== 'resolved' || outcome.value.info === null) {
    return (
      <SheetShell title={title} onClose={onClose}>
        <p className="field-error">{saleLoadFailedLine(name)}</p>
      </SheetShell>
    )
  }

  const { info } = outcome.value
  const viewers = wallet.identity.addresses
  const signer = signerFor(action, nameView(name, info, 'registered'), viewers) ?? viewers[0] ?? ''

  return (
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
      {/* Not a control. One card, one button — see the CTA below. */}
      <div className={styles.cardBody}>
        <div className={styles.cardHeader}>
          <div className={styles.cardNameArea}>
            <Identicon address={offer.seller} size={28} />
            <span className={styles.cardName}>
              <NameText>{offer.name}</NameText>
            </span>
          </div>
          <span className={styles.tagSale}>
            <span className={styles.statusDot} aria-hidden="true" />
            {forSaleLabel()}
          </span>
        </div>

        <div className={styles.cardGrid}>
          <div className={styles.cardPriceGroup}>
            <span className={styles.cardPriceLabel}>{fixedPriceLabel()}</span>
            <div className={styles.cardPriceValue}>
              {lunaToNim(offer.price)}
              <span className={styles.cardPriceUnit}>NIM</span>
            </div>
          </div>
          <button
            type="button"
            className={`${styles.cardActionBtn} ${isOpen ? styles.cardActionBtnOpen : ''}`}
            onClick={onToggle}
          >
            {isOpen ? closeLabel() : buyNowLabel()}
            {!isOpen && <ArrowRightIcon />}
          </button>
        </div>

        <div className={styles.cardMeta}>
          <div className={styles.metaItem}>
            <span className={styles.metaIcon}>
              <Identicon address={offer.seller} size={16} />
            </span>
            <span>{soldByLabel()} <strong className="nns-name">{ellipsizeAddress(offer.seller)}</strong></span>
          </div>
          <div className={styles.metaItem}>
            <span className={styles.metaIcon}><ClockIcon /></span>
            <span>{expiryUntilLine(formatApproxWhen(approxDate(offer.expiryHeight, height, nowMs), nowMs))}</span>
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
      {/* Not a control. One card, one button — see the CTA below. */}
      <div className={styles.cardBody}>
        <div className={styles.cardHeader}>
          <div className={styles.cardNameArea}>
            <Identicon address={auction.seller} size={28} />
            <span className={styles.cardName}>
              <NameText>{auction.name}</NameText>
            </span>
          </div>
          <span className={styles.tagAuction}>
            <span className={styles.statusDot} aria-hidden="true" />
            {liveAuctionLabel()}
          </span>
        </div>

        <div className={styles.cardGrid}>
          <div className={styles.cardPriceGroup}>
            <span className={styles.cardPriceLabel}>{standing ? startingPriceLabel() : standingBidLabel()}</span>
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
            onClick={onToggle}
          >
            {isOpen ? closeLabel() : placeBidLabel()}
            {!isOpen && <ArrowRightIcon />}
          </button>
        </div>

        <div className={styles.cardMeta}>
          <div className={styles.metaItem}>
            <span className={styles.metaIcon}>
              <Identicon address={auction.seller} size={16} />
            </span>
            <span>{listedByLabel()} <strong className="nns-name">{ellipsizeAddress(auction.seller)}</strong></span>
          </div>
          <div className={styles.metaItem}>
            <span className={styles.metaIcon}><ClockIcon /></span>
            <span>{auctionEndsLine(formatApproxWhen(approxDate(auction.endHeight, height, nowMs), nowMs))}</span>
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
            <h1 className={styles.marketTitle}>{SCREEN_TITLE.market}</h1>
            <p className={styles.marketSubtitle}>{SCREEN_SUB.market}</p>
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
                  placeholder={marketFilterPlaceholder()}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  aria-label={marketFilterAria()}
                />
                {searchQuery.trim() !== '' && (
                  <button
                    type="button"
                    className={styles.searchClear}
                    onClick={() => setSearchQuery('')}
                    aria-label={clearLabel()}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>

              <div className={styles.filterPills}>
                {(['all', 'offers', 'auctions'] as const).map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    className={`${styles.filterBtn} ${tab === entry ? styles.filterBtnActive : ''}`}
                    onClick={() => setTab(entry)}
                  >
                    {MARKET_FILTER[entry]}
                    <span className={styles.filterBadge}>
                      {entry === 'all' ? totalListings : entry === 'offers' ? totalOffersCount : totalAuctionsCount}
                    </span>
                  </button>
                ))}
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
                <h3 className={styles.emptyTitle}>{offersEmptyTitle()}</h3>
                <p className={styles.emptyBody}>{offersEmptyBody()}</p>
              </div>
            ) : totalDisplayed === 0 ? (
              <div className={styles.emptyCard}>
                <div className={styles.emptyIcon}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </div>
                <h3 className={styles.emptyTitle}>{marketNoMatchTitle()}</h3>
                <p className={styles.emptyBody}>{marketNoMatchLine(searchQuery.trim(), tab === 'all' ? null : MARKET_FILTER[tab])}</p>
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

            {/* The screen's own disclosure. Neutral wording, not the buy
                variant it used to carry: this list holds auctions too, and half
                its rows take a bid rather than a payment. The circle was a
                decorative SVG beside a paragraph; it is a real `Hint` button
                now, so the detail is reachable by keyboard and announced as a
                control. */}
            <div className={styles.custodialBox}>
              <p className={styles.custodialText}>
                {marketCustodialLine()}
                <Hint glyph="i">{marketCustodialHint()}</Hint>
              </p>
            </div>

            <BurnFigures />
          </div>

          <TrustBar screen="market" />
        </div>
      </div>
    </div>
  )
}
