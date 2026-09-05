import React, { useState, useEffect, useRef } from 'react'
import { useAsync } from '../lib/useAsync'
import { getBurn } from '../lib/api'
import { apiBase } from '../lib/nns'
import { lunaToNim } from '../lib/format'
import styles from './landing-page.module.css'


const MOCK_PROFILES = [
  { name: 'rico', address: 'NQ14 9V83 P2K1 U5L4 7T9Y 6X4M 2A1B 3C5D', evm: '0x71C84976722883446059F2e616238b9C5E4EcB29', color: '#F6851B' }, // Orange
  { name: 'satoshi', address: 'NQ42 1B3C 5D7E 9F2G 4H6J 8K0L 1M3N 5P7Q', evm: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', color: '#E9B213' }, // Gold
  { name: 'kike', address: 'NQ99 Z9Y8 X7W6 V5U4 T3S2 R1Q0 P9O8 N7M6', evm: '0x1B3F6a09E2c40D55c8a1b2C3d4E5F60718293A4b', color: '#E25822' }, // Flame
  { name: 'burn', address: 'NQ88 A1B2 C3D4 E5F6 G7H8 I9J0 K1L2 M3N4', evm: '0x000000000000000000000000000000000000dEaD', color: '#F9A826' }, // Sunburst
  { name: 'vlad', address: 'NQ11 QWE1 RTY2 UIO3 PAS4 DFG5 HJK6 LZ7X', evm: '0x3f5CE5FBFe3E9af3971dD833D26bA9b5C936f0bE', color: '#D35400' }, // Pumpkin
];

const MARQUEE_ITEMS = Array(10).fill(MOCK_PROFILES).flat();

/**
 * **Home** — The landing page and hub. Introduces the user to NNS with
 * Nimiq-themed visuals, a Hero section, and routing to other features.
 */
const formatStat = (luna: bigint) => {
  const nim = Number(luna) / 100000;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(nim);
}

export function HomeScreen({ onSearch }: { onSearch: (query: string) => void }) {
  const [query, setQuery] = useState('')
  const burn = useAsync(() => getBurn(apiBase()), [])

  return (
    <div className="screen home-screen">
      <div className={styles.lightThemeWrapper}>
        <div className={`hero-section ${styles.heroSection}`}>



          <div className={`hero-content ${styles.heroContent}`}>
            <h2 className={`hero-title ${styles.heroTitle}`}>Your name on <span className={styles.highlightText}>Nimiq</span></h2>
            <p className={`hero-description ${styles.heroDescription}`}>
              Replace complex wallet addresses<br /> with a single, memorable name.
            </p>

            <form
              className={`hero-search ${styles.heroSearch}`}
              onSubmit={(event) => {
                event.preventDefault()
                if (query.trim() !== '') {
                  onSearch(query.trim())
                }
              }}
            >
              <div className={`hero-search-wrapper ${styles.searchWrapper}`}>
                <div className={styles.searchIcon}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8"></circle>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                  </svg>
                </div>
                <input
                  className={`hero-search-input nns-name ${styles.searchInput}`}
                  type="text"
                  inputMode="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="Search for a name..."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label="Search for a name"
                />
                <button className={`hero-search-go ${styles.searchBtn}`} type="submit" disabled={query.trim() === ''}>
                  Search
                </button>
              </div>
            </form>

            {/* Borderless Typographic Trust Line */}
            <div className={styles.trustLine}>
              <div className={styles.trustItem}>
                <svg className={styles.trustIcon} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                </svg>
                <span>100% On-Chain</span>
              </div>
              <span className={styles.trustDot}>•</span>
              <div className={styles.trustItem}>
                <svg className={styles.trustIcon} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                  <path d="m9 12 2 2 4-4"></path>
                </svg>
                <span>Self-Custody</span>
              </div>
              <span className={styles.trustDot}>•</span>
              <div className={styles.trustItem}>
                <svg className={styles.trustIcon} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                  <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                  <line x1="12" y1="22.08" x2="12" y2="12"></line>
                </svg>
                <span>Zero Contracts</span>
              </div>
            </div>
          </div>

          {/* --- Synchronized Address-to-Card Marquee --- */}
          <div className={styles.marqueeContainer}>
            <div className={styles.marqueeLaserContainer}>
              <div className={styles.laserBurst} />
              <div className={styles.laserBurstInner} />
            </div>

            {/* Track A: Raw Addresses */}
            <div className={`${styles.marqueeTrack} ${styles.trackRaw}`}>
              <div className={styles.marqueeContent}>
                {MARQUEE_ITEMS.map((p, i) => (
                  <div key={i} className={styles.marqueeItemWrapper}>
                    <div className={styles.rawAddressItem}>{p.address}</div>
                  </div>
                ))}
              </div>
              {/* Second copy for infinite scroll loop */}
              <div className={styles.marqueeContent}>
                {MARQUEE_ITEMS.map((p, i) => (
                  <div key={`dup-${i}`} className={styles.marqueeItemWrapper}>
                    <div className={styles.rawAddressItem}>{p.address}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Track B: Profile Cards (Masked to right half) */}
            <div className={`${styles.marqueeTrack} ${styles.trackCards}`}>
              <div className={styles.marqueeContent}>
                {MARQUEE_ITEMS.map((p, i) => (
                  <div key={i} className={styles.marqueeItemWrapper}>
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
                        <div className={styles.cardAddressLabel}>Linked Addresses</div>
                        <div className={styles.cardAddressValue} title={p.address}>{p.address}</div>
                        <div className={styles.cardAddressValue} style={{ marginTop: '4px' }} title={p.evm}>{p.evm}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {/* Second copy for infinite scroll loop */}
              <div className={styles.marqueeContent}>
                {MARQUEE_ITEMS.map((p, i) => (
                  <div key={`dup-${i}`} className={styles.marqueeItemWrapper}>
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
                        <div className={styles.cardAddressLabel}>Linked Addresses</div>
                        <div className={styles.cardAddressValue} title={p.address}>{p.address}</div>
                        <div className={styles.cardAddressValue} style={{ marginTop: '4px' }} title={p.evm}>{p.evm}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <section className="features-section light-bento-section">
          <div className="bento-header">
            <h3 className="section-title">
              One name. <span className="text-highlight-orange">Everything</span> you need.
            </h3>
            <p className="section-subtitle">
              Discover everything you can do with your Nimiq identity —<br />
              from managing your name to sending payments and connecting with others.
            </p>
          </div>

          <div className="features-grid bento-grid">

            {/* Card 1: Half (span 3) */}
            <div className="feature-card glass-card bento-half">
              <div className="feature-image-wrapper feature-image-half">
                <picture>
                  <source media="(max-width: 768px)" srcSet="/assets/images/feature_search_register_mobile.png?v=5" />
                  <img src="/assets/images/feature_search_register.png?v=3" alt="Search & Register" className="feature-image" />
                </picture>
              </div>
              <div className="feature-content-wrapper">
                <div className="feature-content">
                  <h4>Search & Register</h4>
                  <p>Find the perfect name and secure it instantly.<br />Your web3 identity is waiting.</p>
                </div>
                <div className="feature-arrow arrow-orange">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                </div>
              </div>
            </div>

            {/* Card 2: Half (span 3) */}
            <div className="feature-card glass-card bento-half">
              <div className="feature-image-wrapper feature-image-half">
                <img src="/assets/images/feature_manage_identity.jpeg?v=3" alt="Manage Records" className="feature-image" />
              </div>
              <div className="feature-content-wrapper">
                <div className="feature-content">
                  <h4>Manage Records</h4>
                  <p>Configure your Nimiq address, link EVM<br />wallets, and delegate subdomains.</p>
                </div>
                <div className="feature-arrow arrow-orange">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                </div>
              </div>
            </div>

            {/* Card 3: Third (span 2) */}
            <div className="feature-card glass-card bento-third">
              <div className="feature-image-wrapper feature-image-third">
                <img src="/assets/images/feature_marketplace.png?v=3" alt="Marketplace" className="feature-image" />
              </div>
              <div className="feature-content-wrapper">
                <div className="feature-content">
                  <h4>Marketplace</h4>
                  <p>Browse, buy, and sell premium names<br />on the open market.</p>
                </div>
                <div className="feature-arrow arrow-purple">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                </div>
              </div>
            </div>

            {/* Card 4: Third (span 2) */}
            <div className="feature-card glass-card bento-third">
              <div className="feature-image-wrapper feature-image-third">
                <img src="/assets/images/feature_instant_payments.png?v=3" alt="Instant Payments" className="feature-image" />
              </div>
              <div className="feature-content-wrapper">
                <div className="feature-content">
                  <h4>Instant Payments</h4>
                  <p>Send and receive NIM seamlessly<br />using memorable names.</p>
                </div>
                <div className="feature-arrow arrow-blue">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                </div>
              </div>
            </div>

            {/* Card 5: Third (span 2) */}
            <div className="feature-card glass-card bento-third">
              <div className="feature-image-wrapper feature-image-third">
                <img src="/assets/images/feature_secure_chat.png?v=3" alt="On-Chain Messaging" className="feature-image" />
              </div>
              <div className="feature-content-wrapper">
                <div className="feature-content">
                  <h4>On-Chain Messaging</h4>
                  <p>Ping name owners directly on-chain<br />with transaction memos to connect.</p>
                </div>
                <div className="feature-arrow arrow-coral">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                </div>
              </div>
            </div>

          </div>
        </section>
      </div>

      {/* How it Works Section - Open Timeline Pedestal Flow */}
      <section className="how-it-works-section">
        <div className="how-it-works-container">
          <div className="how-it-works-header">
            <span className="how-it-works-badge">
              <span className="badge-pulse" />
              Easy Onboarding
            </span>
            <h3 className="section-title">How it Works</h3>
            <p className="section-subtitle">
              Get your decentralized Nimiq identity up and running in three simple steps.
            </p>
          </div>

          <div className="how-it-works-flow">
            {/* Horizontal glowing timeline track */}
            <div className="timeline-track" aria-hidden="true">
              <div className="timeline-line" />
            </div>

            <div className="steps-flow-grid">
              {/* Step 1 */}
              <div className="step-flow-item">
                <div className="step-node">
                  <span className="step-num">01</span>
                </div>
                <div className="step-stage">
                  <img src="/assets/images/how_it_works_search.jpg" alt="Search & Register" loading="lazy" />
                </div>
                <div className="step-meta">
                  <h4>Search & Register</h4>
                  <p>Find an available name and register it directly on the blockchain.</p>
                </div>
              </div>

              {/* Step 2 */}
              <div className="step-flow-item">
                <div className="step-node">
                  <span className="step-num">02</span>
                </div>
                <div className="step-stage">
                  <img src="/assets/images/how_it_works_profile.jpg" alt="Link Addresses" loading="lazy" />
                </div>
                <div className="step-meta">
                  <h4>Link Addresses</h4>
                  <p>Configure your primary Nimiq address and attach EVM wallets for multi-chain payments.</p>
                </div>
              </div>

              {/* Step 3 */}
              <div className="step-flow-item">
                <div className="step-node">
                  <span className="step-num">03</span>
                </div>
                <div className="step-stage">
                  <img src="/assets/images/how_it_works_transact.jpg" alt="Start Transacting" loading="lazy" />
                </div>
                <div className="step-meta">
                  <h4>Start Transacting</h4>
                  <p>Send and receive NIM instantly using your new, memorable identity.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Cross-Chain Security Section */}
      <section className="cross-chain-section">
        <div className="cross-chain-container">
          <div className="cross-chain-content">
            <span className="cross-chain-badge">
              <span className="badge-pulse pulse-blue" />
              Multi-Chain Routing
            </span>
            <h3 className="section-title">One Name. <span className="text-highlight-blue">Multi-Chain Routing</span>. Fully Secure.</h3>

            <div className="security-feature">
              <div className="security-icon icon-gold">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
              </div>
              <div className="security-text">
                <h4>Decentralized Ownership</h4>
                <p>Secured directly on the Nimiq blockchain. Self-custodied with your private keys, with zero smart-contract middlemen.</p>
              </div>
            </div>

            <div className="security-feature">
              <div className="security-icon icon-purple">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
              </div>
              <div className="security-text">
                <h4>Multi-Chain EVM Payments</h4>
                <p>Attach any EVM address (0x...) to receive stablecoins like USDC and USDT seamlessly over Polygon, Ethereum, or Arbitrum in Nimiq Pay.</p>
              </div>
            </div>

            <div className="security-feature">
              <div className="security-icon icon-blue">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
              </div>
              <div className="security-text">
                <h4>Subdomain Delegation</h4>
                <p>Configure off-chain delegate hosts to resolve unlimited subdomains (e.g. pay.yourname) dynamically without on-chain bloat.</p>
              </div>
            </div>
          </div>

          <div className="cross-chain-visual">
            <div className="video-container">
              <video autoPlay loop muted playsInline className="cross-chain-video">
                <source src="/multiple-chains.mp4" type="video/mp4" />
                Your browser does not support the video tag.
              </video>
            </div>
          </div>
        </div>
      </section>

      {/* Stats / Protocol Economics Section */}
      <section className="stats-section">
        <div className="stats-container" style={{ position: 'relative', zIndex: 10 }}>
          <div className="stats-header">
            <span className="stats-badge">
              <span className="badge-pulse pulse-orange" />
              Protocol Economics
            </span>
            <h3 className="section-title">Built for the <span className="text-highlight-orange">Nimiq</span> Ecosystem</h3>
            <p className="section-subtitle">
              Every name registered permanently burns NIM, decreasing the total supply and creating long-term value for the entire network.
            </p>
          </div>

          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-icon-wrap">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 14 14"></polyline></svg>
              </div>
              <div className="stat-value">{burn.status === 'done' ? `${formatStat(burn.value.revenue)}` : '...'}</div>
              <div className="stat-label">Total NIM Revenue</div>
              <div className="stat-sublabel">Cumulative volume processed</div>
            </div>

            <div className="stat-card highlight">
              <div className="stat-icon-wrap burn-icon">
                <span className="burn-flame">🔥</span>
              </div>
              <div className="stat-value">{burn.status === 'done' ? `${formatStat(burn.value.burned)}` : '...'}</div>
              <div className="stat-label">NIM Burned</div>
              <div className="stat-sublabel">Permanently removed from supply</div>
            </div>

            <div className="stat-card">
              <div className="stat-icon-wrap">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
              </div>
              <div className="stat-value">{burn.status === 'done' ? `${formatStat(burn.value.owed)}` : '...'}</div>
              <div className="stat-label">Owed to Protocol</div>
              <div className="stat-sublabel">Pending distribution cycle</div>
            </div>
          </div>
        </div>
      </section>
      {/* Final CTA Section */}
      <section className="final-cta">
        {/* Background Vectors */}
        <div className="cta-bg-vectors">
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
            Decentralized Identity
          </span>
          <h2 className="cta-title">
            Ready to Claim Your <span className="text-highlight-gold">Web3 Identity</span>?
          </h2>
          <p className="cta-subtitle">
            Claim your unique name today. Map your Nimiq address, attach EVM wallets, and start receiving payments effortlessly.
          </p>
          <div className="cta-actions">
            <button
              className="cta-btn primary-btn"
              onClick={() => {
                window.scrollTo({ top: 0, behavior: 'smooth' })
                setTimeout(() => {
                  const searchInput = document.querySelector('.hero-search-input') as HTMLInputElement | null
                  if (searchInput) {
                    searchInput.focus()
                    searchInput.select()
                  }
                }, 600)
              }}
            >
              <span>Find Your Name</span>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12"></line>
                <polyline points="12 5 19 12 12 19"></polyline>
              </svg>
            </button>
          </div>

          <div className="cta-perks">
            <div className="cta-perk-item">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              <span>Flexible 1-Year Terms</span>
            </div>
            <div className="cta-perk-divider" />
            <div className="cta-perk-item">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              <span>Multi-Chain Ready</span>
            </div>
            <div className="cta-perk-divider" />
            <div className="cta-perk-item">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              <span>100% Self-Custodial</span>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <h2 className="footer-logo">nns<span>.</span></h2>
            <p>The decentralized naming service for the Nimiq blockchain and beyond.</p>
          </div>
          <div className="footer-links">
            <div className="link-column">
              <h4>Ecosystem</h4>
              <a href="https://wallet.nimiq.com" target="_blank" rel="noopener noreferrer">Nimiq Wallet</a>
              <a href="https://cryptocity.com" target="_blank" rel="noopener noreferrer">Cryptocity</a>
              <a href="https://oasis.nimiq.com" target="_blank" rel="noopener noreferrer">Oasis</a>
            </div>
            <div className="link-column">
              <h4>Resources</h4>
              <a href="https://nimiq.com/developers" target="_blank" rel="noopener noreferrer">Developer Docs</a>
              <a href="https://github.com/selfcrypto/nns" target="_blank" rel="noopener noreferrer">GitHub Repo</a>
              <a href="https://nimiq.com" target="_blank" rel="noopener noreferrer">Nimiq Network</a>
            </div>
            <div className="link-column">
              <h4>Community</h4>
              <a href="https://x.com/nimiq" target="_blank" rel="noopener noreferrer">X (Twitter)</a>
              <a href="https://discord.gg/nimiq" target="_blank" rel="noopener noreferrer">Discord</a>
              <a href="https://t.me/Nimiq" target="_blank" rel="noopener noreferrer">Telegram</a>
            </div>
          </div>
        </div>
        <div className="footer-bottom">
          <p className="footer-copyright">&copy; {new Date().getFullYear()} Nimiq Name Service. All rights reserved.</p>
        </div>
      </footer>
    </div>
  )
}
