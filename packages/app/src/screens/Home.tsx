import { Fragment, useRef, useState } from 'react'
import { useAsync } from '../lib/useAsync'
import { getBurn } from '../lib/api'
import { apiBase } from '../lib/nns'
import { lunaToNim } from '../lib/format'
import { LANDING, SITE_NAME, referrerKeptLine } from '../lib/wording'
import { BRAND_MARK } from '../lib/brand'
import { EXAMPLE_PROFILES } from '../lib/examples'
import { referralFromLink, rememberReferral, storedReferral } from '../lib/referral'
import { ReferrerStrip } from '../components/ReferrerStrip'
import styles from './landing-page.module.css'

/**
 * **Home** — the landing page both hosts open on, a browser and Nimiq Pay
 * alike (App.tsx). Marketing, not the app: nothing here resolves a name or
 * shows a state. It has three ways in, because the tab bar is hidden here and
 * a search field is only one of them: the hero's query goes to Buy,
 * `onOpenApp` goes to My names, and "How it works" goes to the docs. Every
 * string is `LANDING` in `wording.ts`; the layout is
 * `landing-page.module.css`, which reaches into the masthead through
 * `:global(.frame.is-home …)`.
 */

const MARQUEE_ITEMS = Array<typeof EXAMPLE_PROFILES>(10).fill(EXAMPLE_PROFILES).flat()

const IMAGES = '/assets/images'

function Arrow({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  )
}

function Check() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

const TRUST_ICONS = [
  <polygon key="bolt" points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
  <g key="shield"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></g>,
  <g key="box"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></g>,
]

const FEATURE_CARDS = [
  { image: 'feature_search_register', mobile: 'feature_search_register_mobile', span: 'half', arrow: 'orange' },
  { image: 'feature_manage_identity', span: 'half', arrow: 'orange' },
  { image: 'feature_marketplace', span: 'third', arrow: 'purple' },
  { image: 'feature_instant_payments', span: 'third', arrow: 'blue' },
  { image: 'feature_secure_chat', span: 'third', arrow: 'coral' },
] as const

const STEP_IMAGES = ['how_it_works_search', 'how_it_works_profile', 'how_it_works_transact'] as const

const CHAIN_ICONS = [
  { tone: 'gold', shape: <g><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></g> },
  { tone: 'purple', shape: <g><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></g> },
  { tone: 'blue', shape: <g><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></g> },
] as const

function ProfileCards({ prefix }: { prefix: string }) {
  return (
    <div className={styles.marqueeContent}>
      {MARQUEE_ITEMS.map((p, i) => (
        <div key={`${prefix}${i}`} className={styles.marqueeItemWrapper}>
          <div className={styles.profileCard}>
            <div className={styles.cardHeader}>
              <div className={styles.cardAvatar} style={{ background: p.color }}>
                {p.name.charAt(0).toUpperCase()}
              </div>
            </div>
            <div className={styles.cardBody}>
              <div className={styles.cardName}>{p.name}</div>
            </div>
            <div className={styles.cardFooter}>
              <div className={styles.cardAddressLabel}>{LANDING.marquee.linked}</div>
              <div className={styles.cardAddressValue} title={p.address}>{p.address}</div>
              <div className={styles.cardAddressValue} style={{ marginTop: '4px' }} title={p.evm}>{p.evm}</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function RawAddresses({ prefix }: { prefix: string }) {
  return (
    <div className={styles.marqueeContent}>
      {MARQUEE_ITEMS.map((p, i) => (
        <div key={`${prefix}${i}`} className={styles.marqueeItemWrapper}>
          <div className={styles.rawAddressItem}>{p.address}</div>
        </div>
      ))}
    </div>
  )
}

export function HomeScreen({ onSearch, onOpenApp }: { onSearch: (query: string) => void; onOpenApp: () => void }) {
  const [query, setQuery] = useState('')
  const [linkNote, setLinkNote] = useState<string | null>(null)
  const burn = useAsync(() => getBurn(apiBase()), [])
  const searchInput = useRef<HTMLInputElement>(null)
  const { hero, features, steps, chains, burn: burnCopy, cta, footer } = LANDING

  /**
   * A **share link** pasted into the hero is read as a link, not searched as
   * a name — the same rule Buy and Pay apply to their own boxes. Here it also
   * covers the reader who was sent a link, opened it in a browser and then
   * pasted it again out of habit.
   */
  const acceptQuery = (value: string) => {
    const ref = referralFromLink(value)
    if (ref === null) {
      setLinkNote(null)
      setQuery(value)
      return
    }
    setQuery('')
    void rememberReferral(ref)
      .then(storedReferral)
      .then((stored) => setLinkNote(stored === null || stored === ref ? null : referrerKeptLine(stored)))
  }

  const stat = (value: bigint | null) => (value === null ? '…' : lunaToNim(value))
  const figures = burn.status === 'done' ? burn.value : null

  return (
    <div className="screen home-screen">
      <div className={styles.lightThemeWrapper}>
        <div className={`hero-section ${styles.heroSection}`}>
          <div className={`hero-content ${styles.heroContent}`}>
            <h2 className={`hero-title ${styles.heroTitle}`}>
              {hero.title} <span className={styles.highlightText}>{hero.titleAccent}</span>
            </h2>
            <p className={`hero-description ${styles.heroDescription}`}>{hero.sub}</p>

            <form
              className={`hero-search ${styles.heroSearch}`}
              onSubmit={(event) => {
                event.preventDefault()
                if (query.trim() !== '') onSearch(query.trim())
              }}
            >
              <div className={`hero-search-wrapper ${styles.searchWrapper}`}>
                <div className={styles.searchIcon}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </div>
                <input
                  ref={searchInput}
                  className={`hero-search-input nns-name ${styles.searchInput}`}
                  type="text"
                  inputMode="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={hero.placeholder}
                  value={query}
                  onChange={(event) => acceptQuery(event.target.value)}
                  aria-label={hero.placeholder}
                />
                <button className={`hero-search-go ${styles.searchBtn}`} type="submit" disabled={query.trim() === ''}>
                  {hero.go}
                </button>
              </div>
            </form>

            {linkNote !== null && <p className={styles.heroLinkNote}>{linkNote}</p>}
            <ReferrerStrip className={styles.heroReferrer} />

            <div className={styles.heroActions}>
              <button type="button" className={styles.heroAppBtn} onClick={onOpenApp}>
                <span>{hero.openApp}</span>
                <Arrow size={17} />
              </button>
              {/* A hash link, so the reader stays in this copy of the app — the
                  footer's docs links say the same thing at more length. */}
              <a className={styles.heroLearnLink} href="#/docs/intro">
                {hero.learn}
              </a>
            </div>

            <div className={styles.trustLine}>
              {hero.trust.map((label, i) => (
                <Fragment key={label}>
                  {i > 0 && <span className={styles.trustDot}>•</span>}
                  <div className={styles.trustItem}>
                    <svg className={styles.trustIcon} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      {TRUST_ICONS[i]}
                    </svg>
                    <span>{label}</span>
                  </div>
                </Fragment>
              ))}
            </div>
          </div>

          {/* Raw addresses scroll in from the left, cards out to the right, one track each. */}
          <div className={styles.marqueeContainer} aria-hidden="true">
            <div className={styles.marqueeLaserContainer}>
              <div className={styles.laserBurst} />
              <div className={styles.laserBurstInner} />
            </div>
            <div className={`${styles.marqueeTrack} ${styles.trackRaw}`}>
              <RawAddresses prefix="a" />
              <RawAddresses prefix="b" />
            </div>
            <div className={`${styles.marqueeTrack} ${styles.trackCards}`}>
              <ProfileCards prefix="a" />
              <ProfileCards prefix="b" />
            </div>
          </div>
        </div>

        <section className="features-section light-bento-section">
          <div className="bento-header">
            <h3 className="section-title">
              {features.title} <span className="text-highlight-orange">{features.titleAccent}</span> {features.titleTail}
            </h3>
          </div>

          <div className="features-grid bento-grid">
            {FEATURE_CARDS.map((card, i) => {
              const copy = features.cards[i]
              if (copy === undefined) return null
              return (
                <div key={card.image} className={`feature-card glass-card bento-${card.span}`}>
                  <div className={`feature-image-wrapper feature-image-${card.span}`}>
                    {'mobile' in card ? (
                      <picture>
                        <source media="(max-width: 768px)" srcSet={`${IMAGES}/${card.mobile}.webp`} />
                        <img src={`${IMAGES}/${card.image}.webp`} alt="" className="feature-image" />
                      </picture>
                    ) : (
                      <img src={`${IMAGES}/${card.image}.webp`} alt="" className="feature-image" loading="lazy" />
                    )}
                  </div>
                  <div className="feature-content-wrapper">
                    <div className="feature-content">
                      <h4>{copy.title}</h4>
                      <p>{copy.body}</p>
                    </div>
                    <div className={`feature-arrow arrow-${card.arrow}`}>
                      <Arrow />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      </div>

      <section className="how-it-works-section">
        <div className="how-it-works-container">
          <div className="how-it-works-header">
            <h3 className="section-title">{steps.title}</h3>
          </div>

          <div className="how-it-works-flow">
            <div className="timeline-track" aria-hidden="true">
              <div className="timeline-line" />
            </div>
            <div className="steps-flow-grid">
              {steps.items.map((step, i) => (
                <div key={step.title} className="step-flow-item">
                  <div className="step-node">
                    <span className="step-num">{String(i + 1).padStart(2, '0')}</span>
                  </div>
                  <div className="step-stage">
                    <img src={`${IMAGES}/${STEP_IMAGES[i]}.webp`} alt="" loading="lazy" />
                  </div>
                  <div className="step-meta">
                    <h4>{step.title}</h4>
                    <p>{step.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="cross-chain-section">
        <div className="cross-chain-container">
          <div className="cross-chain-content">
            <span className="cross-chain-badge">
              <span className="badge-pulse pulse-blue" />
              {chains.badge}
            </span>
            <h3 className="section-title">
              {chains.title} <span className="text-highlight-blue">{chains.titleAccent}</span>{chains.titleTail}
            </h3>

            {chains.items.map((item, i) => (
              <div key={item.title} className="security-feature">
                <div className={`security-icon icon-${CHAIN_ICONS[i]?.tone ?? 'blue'}`}>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {CHAIN_ICONS[i]?.shape}
                  </svg>
                </div>
                <div className="security-text">
                  <h4>{item.title}</h4>
                  <p>{item.body}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="cross-chain-visual">
            <div className="video-container">
              <video autoPlay loop muted playsInline className="cross-chain-video" aria-hidden="true">
                <source src="/multiple-chains.mp4" type="video/mp4" />
              </video>
            </div>
          </div>
        </div>
      </section>

      <section className="stats-section">
        <div className="stats-container" style={{ position: 'relative', zIndex: 10 }}>
          <div className="stats-header">
            <span className="stats-badge">
              <span className="badge-pulse pulse-orange" />
              {burnCopy.badge}
            </span>
            <h3 className="section-title">
              {burnCopy.title} <span className="text-highlight-orange">{burnCopy.titleAccent}</span>
            </h3>
            <p className="section-subtitle">{burnCopy.sub}</p>
          </div>

          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-icon-wrap">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 14 14" /></svg>
              </div>
              <div className="stat-value">{stat(figures?.revenue ?? null)}</div>
              <div className="stat-label">{burnCopy.revenue.label}</div>
              <div className="stat-sublabel">{burnCopy.revenue.sub}</div>
            </div>

            <div className="stat-card highlight">
              <div className="stat-icon-wrap burn-icon">
                <svg className="burn-flame" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
                </svg>
              </div>
              <div className="stat-value">{stat(figures?.burned ?? null)}</div>
              <div className="stat-label">{burnCopy.burned.label}</div>
              <div className="stat-sublabel">{burnCopy.burned.sub}</div>
            </div>

            <div className="stat-card">
              <div className="stat-icon-wrap">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></svg>
              </div>
              <div className="stat-value">{stat(figures?.owed ?? null)}</div>
              <div className="stat-label">{burnCopy.owed.label}</div>
              <div className="stat-sublabel">{burnCopy.owed.sub}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="final-cta">
        <div className="cta-bg-vectors" aria-hidden="true">
          <svg className="cta-hex hex-left" viewBox="0 0 100 115.47" width="280">
            <polygon points="50 0, 100 28.87, 100 86.6, 50 115.47, 0 86.6, 0 28.87" />
          </svg>
          <svg className="cta-hex hex-right" viewBox="0 0 100 115.47" width="360">
            <polygon points="50 0, 100 28.87, 100 86.6, 50 115.47, 0 86.6, 0 28.87" />
          </svg>
        </div>

        <div className="cta-content">
          <span className="cta-badge">
            <span className="badge-pulse pulse-gold" />
            {cta.badge}
          </span>
          <h2 className="cta-title">
            {cta.title} <span className="text-highlight-gold">{cta.titleAccent}</span>
          </h2>
          <div className="cta-actions">
            <button
              type="button"
              className="cta-btn primary-btn"
              onClick={() => {
                const input = searchInput.current
                if (input === null) return
                input.focus({ preventScroll: true })
                input.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }}
            >
              <span>{cta.go}</span>
              <Arrow size={18} />
            </button>
          </div>

          <div className="cta-perks">
            {cta.perks.map((perk, i) => (
              <Fragment key={perk}>
                {i > 0 && <div className="cta-perk-divider" />}
                <div className="cta-perk-item">
                  <Check />
                  <span>{perk}</span>
                </div>
              </Fragment>
            ))}
          </div>
        </div>
      </section>

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <h2 className="footer-logo">
              <img src={BRAND_MARK} alt="" width="34" height="34" />
              {SITE_NAME}
            </h2>
            <p>{footer.tagline}</p>
          </div>
          <div className="footer-links">
            {footer.columns.map((column) => (
              <div key={column.title} className="link-column">
                <h4>{column.title}</h4>
                {/* A `#/docs/...` link is this app's own page: opening it in
                    a new tab would leave the reader in a second copy of the
                    app with no way back to where they were. */}
                {column.links.map(([label, href]) => (
                  <a key={href} href={href} {...(href.startsWith('#') ? {} : { target: '_blank', rel: 'noopener noreferrer' })}>
                    {label}
                  </a>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="footer-bottom">
          <p className="footer-copyright">{footer.copyright(new Date().getFullYear())}</p>
        </div>
      </footer>
    </div>
  )
}
