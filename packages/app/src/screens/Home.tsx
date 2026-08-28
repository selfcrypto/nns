import { useState } from 'react'
import { useAsync } from '../lib/useAsync'
import { getBurn } from '../lib/api'
import { apiBase } from '../lib/nns'
import { lunaToNim } from '../lib/format'

/**
 * **Home** — The landing page and hub. Introduces the user to NNS with
 * Nimiq-themed visuals, a Hero section, and routing to other features.
 */
export function HomeScreen({ onSearch }: { onSearch: (query: string) => void }) {
  const [query, setQuery] = useState('')
  const burn = useAsync(() => getBurn(apiBase()), [])

  const formatStat = (luna: bigint) => {
    const nim = Number(luna) / 100000;
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(nim);
  }

  return (
    <div className="screen home-screen">
      <div className="hero-section">
        
        {/* Soft, glowing Nimiq-style animated gradient orbs */}
        {/* Nimiq-style flat geometric background */}
        <div className="hero-graphic" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden', pointerEvents: 'none' }}>
          {/* Desktop SVG - Original crossing shards */}
          <svg className="hero-bg-desktop" viewBox="0 0 1000 600" preserveAspectRatio="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%', zIndex: 0, opacity: 0.15 }}>
            <polygon points="0,0 1000,0 1000,600" fill="#21BCA5" />
            <polygon points="0,0 700,600 1000,600" fill="#0582CA" />
            <polygon points="0,0 400,600 0,600" fill="#E9B213" />
            <polygon points="0,600 400,600 700,0" fill="#F6851B" />
          </svg>
          
          {/* Mobile SVG - Radiating fan layout (no crossing) */}
          <svg className="hero-bg-mobile" viewBox="0 0 1000 600" preserveAspectRatio="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%', zIndex: 0, opacity: 0.15 }}>
            <polygon points="0,0 1000,0 1000,600" fill="#21BCA5" />
            <polygon points="0,0 700,600 1000,600" fill="#0582CA" />
            <polygon points="0,0 400,600 700,600" fill="#F6851B" />
            <polygon points="0,0 0,600 400,600" fill="#E9B213" />
          </svg>
          
          {/* Floating Feature Hexagons */}
          <div className="hero-floating-hex" style={{ position: 'absolute', top: '15%', left: '15%', animation: 'float-hex 6s ease-in-out infinite' }}>
            <svg className="hex-bg" viewBox="0 0 116 100" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', overflow: 'visible', zIndex: 0 }}><polygon points="29,0 87,0 116,50 87,100 29,100 0,50" fill="#0582CA" stroke="#0582CA" strokeWidth="12" strokeLinejoin="round" /></svg>
            <div style={{ position: 'relative', zIndex: 1, width: 32, height: 32, color: 'white' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11,3 18,7 18,15 11,19 4,15 4,7" /><line x1="22" y1="22" x2="16" y2="16"></line></svg>
            </div>
          </div>
          <div className="hero-floating-hex" style={{ position: 'absolute', top: '25%', right: '20%', animation: 'float-hex 8s ease-in-out infinite 1s' }}>
            <svg className="hex-bg" viewBox="0 0 116 100" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', overflow: 'visible', zIndex: 0 }}><polygon points="29,0 87,0 116,50 87,100 29,100 0,50" fill="#E9B213" stroke="#E9B213" strokeWidth="12" strokeLinejoin="round" /></svg>
            <div style={{ position: 'relative', zIndex: 1, width: 32, height: 32, color: 'white' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
            </div>
          </div>
          <div className="hero-floating-hex" style={{ position: 'absolute', bottom: '20%', left: '25%', animation: 'float-hex 7s ease-in-out infinite 2s' }}>
            <svg className="hex-bg" viewBox="0 0 116 100" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', overflow: 'visible', zIndex: 0 }}><polygon points="29,0 87,0 116,50 87,100 29,100 0,50" fill="#21BCA5" stroke="#21BCA5" strokeWidth="12" strokeLinejoin="round" /></svg>
            <div style={{ position: 'relative', zIndex: 1, width: 32, height: 32, color: 'white' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2l-4-4H8l-4 4v2"></path><polygon points="12,3 15.5,5 15.5,9 12,11 8.5,9 8.5,5" /></svg>
            </div>
          </div>
          <div className="hero-floating-hex" style={{ position: 'absolute', bottom: '30%', right: '15%', animation: 'float-hex 9s ease-in-out infinite 0.5s' }}>
            <svg className="hex-bg" viewBox="0 0 116 100" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', overflow: 'visible', zIndex: 0 }}><polygon points="29,0 87,0 116,50 87,100 29,100 0,50" fill="#F6851B" stroke="#F6851B" strokeWidth="12" strokeLinejoin="round" /></svg>
            <div style={{ position: 'relative', zIndex: 1, width: 32, height: 32, color: 'white' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15l-2 2H7l-4 4V5l2-2h14l2 2z"></path></svg>
            </div>
          </div>
        </div>

        <div className="hero-content">
          <h2 className="hero-title">The Ultimate Naming Service for Nimiq</h2>
          <p className="hero-description">
            Replace complex wallet addresses with a single, memorable name. Send instant payments, chat securely, and easily navigate the Nimiq ecosystem.
          </p>

          <form
            className="hero-search"
            onSubmit={(event) => {
              event.preventDefault()
              if (query.trim() !== '') {
                onSearch(query.trim())
              }
            }}
          >
            <div className="hero-search-wrapper">
              <input
                className="hero-search-input nns-name"
                type="text"
                inputMode="text"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Find your .nimiq name..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search for a name"
              />
              <button className="hero-search-go" type="submit" disabled={query.trim() === ''}>
                Search
              </button>
            </div>
          </form>
        </div>
      </div>
      
      <section className="features-section">
        <h3 className="section-title">Everything you need in one place</h3>
        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon icon-blue" style={{ position: 'relative' }}>
              <svg className="hex-bg" viewBox="0 0 116 100" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', overflow: 'visible', zIndex: 0 }}><polygon points="29,0 87,0 116,50 87,100 29,100 0,50" fill="currentColor" stroke="currentColor" strokeWidth="12" strokeLinejoin="round" opacity="0.1" /></svg>
              <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
              </div>
            </div>
            <h4>Search & Buy</h4>
            <p>Find the perfect .nimiq name and secure it, or browse offers on the open marketplace.</p>
          </div>

          <div className="feature-card">
            <div className="feature-icon icon-gold" style={{ position: 'relative' }}>
              <svg className="hex-bg" viewBox="0 0 116 100" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', overflow: 'visible', zIndex: 0 }}><polygon points="29,0 87,0 116,50 87,100 29,100 0,50" fill="currentColor" stroke="currentColor" strokeWidth="12" strokeLinejoin="round" opacity="0.1" /></svg>
              <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
              </div>
            </div>
            <h4>Manage Identity</h4>
            <p>Set up your profile and configure your names in one simple dashboard.</p>
          </div>

          <div className="feature-card">
            <div className="feature-icon icon-green" style={{ position: 'relative' }}>
              <svg className="hex-bg" viewBox="0 0 116 100" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', overflow: 'visible', zIndex: 0 }}><polygon points="29,0 87,0 116,50 87,100 29,100 0,50" fill="currentColor" stroke="currentColor" strokeWidth="12" strokeLinejoin="round" opacity="0.1" /></svg>
              <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
              </div>
            </div>
            <h4>Instant Payments</h4>
            <p>Send and receive NIM seamlessly using memorable .nimiq names instead of complex addresses.</p>
          </div>

          <div className="feature-card">
            <div className="feature-icon icon-purple" style={{ position: 'relative' }}>
              <svg className="hex-bg" viewBox="0 0 116 100" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', overflow: 'visible', zIndex: 0 }}><polygon points="29,0 87,0 116,50 87,100 29,100 0,50" fill="currentColor" stroke="currentColor" strokeWidth="12" strokeLinejoin="round" opacity="0.1" /></svg>
              <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
              </div>
            </div>
            <h4>Secure Chat</h4>
            <p>Communicate privately with other users directly through your registered names.</p>
          </div>
        </div>
      </section>

      {/* How it Works Section */}
      <section className="how-it-works-section">
        {/* Animated Globe Texture */}
        <div className="globe-texture">
          <svg viewBox="0 0 200 200" fill="none" stroke="currentColor" strokeWidth="0.5">
            <circle cx="100" cy="100" r="90"/>
            <ellipse cx="100" cy="100" rx="45" ry="90"/>
            <ellipse cx="100" cy="100" rx="20" ry="90"/>
            <ellipse cx="100" cy="100" rx="70" ry="90"/>
            <line x1="10" y1="100" x2="190" y2="100"/>
            <ellipse cx="100" cy="100" rx="90" ry="45"/>
            <ellipse cx="100" cy="100" rx="90" ry="20"/>
            <ellipse cx="100" cy="100" rx="90" ry="70"/>
          </svg>
        </div>

        <h3 className="section-title">How it Works</h3>
        
        <div className="steps-container">
          <div className="step-card">
            <div className="step-number">1</div>
            <h4>Search & Register</h4>
            <p>Find an available .nimiq name and register it directly on the blockchain.</p>
          </div>
          
          <div className="step-connector"></div>

          <div className="step-card">
            <div className="step-number">2</div>
            <h4>Configure Profile</h4>
            <p>Link your wallet address, set a custom avatar, and add social links.</p>
          </div>

          <div className="step-connector"></div>

          <div className="step-card">
            <div className="step-number">3</div>
            <h4>Start Transacting</h4>
            <p>Send and receive NIM instantly using your new, memorable identity.</p>
          </div>
        </div>
      </section>

      {/* Cross-Chain Security Section */}
      <section className="cross-chain-section">
        <div className="cross-chain-container">
          <div className="cross-chain-content">
            <h3 className="section-title">One Name. Any Chain. Fully Secure.</h3>
            
            <div className="security-feature">
              <div className="security-icon icon-gold">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
              </div>
              <div className="security-text">
                <h4>True Ownership</h4>
                <p>Secured directly on the Nimiq blockchain. No central authority can take your name or censor your identity.</p>
              </div>
            </div>

            <div className="security-feature">
              <div className="security-icon icon-blue">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
              </div>
              <div className="security-text">
                <h4>Cross-Chain Resolution</h4>
                <p>Map your .nimiq name to BTC, ETH, and other network addresses. Use one single identity for your entire crypto portfolio.</p>
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
            <h3>Built for the Nimiq Ecosystem</h3>
            <p>Every .nimiq name registered burns NIM, decreasing the total supply and benefiting the entire network.</p>
          </div>
          
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-value">{burn.status === 'done' ? `${formatStat(burn.value.revenue)}` : '...'}</div>
              <div className="stat-label">NIM Revenue</div>
            </div>
            <div className="stat-card highlight">
              <div className="stat-value">{burn.status === 'done' ? `${formatStat(burn.value.burned)}` : '...'}</div>
              <div className="stat-label">NIM Burned 🔥</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{burn.status === 'done' ? `${formatStat(burn.value.owed)}` : '...'}</div>
              <div className="stat-label">Owed to Protocol</div>
            </div>
          </div>
        </div>
      </section>
      {/* Final CTA Section */}
      <section className="final-cta">
        {/* Background Vectors */}
        <div className="cta-bg-vectors">
          <svg className="cta-hex hex-left" viewBox="0 0 100 115.47" width="250" opacity="0.05">
            <polygon points="50 0, 100 28.87, 100 86.6, 50 115.47, 0 86.6, 0 28.87" fill="var(--nimiq-blue)"/>
          </svg>
          <svg className="cta-hex hex-right" viewBox="0 0 100 115.47" width="350" opacity="0.05">
            <polygon points="50 0, 100 28.87, 100 86.6, 50 115.47, 0 86.6, 0 28.87" fill="none" stroke="var(--accent)" strokeWidth="2"/>
          </svg>
        </div>

        <div className="cta-content" style={{ position: 'relative', zIndex: 10 }}>
          <h2>Ready to claim your digital identity?</h2>
          <p>Join thousands of others in the Nimiq Ecosystem today.</p>
          <button className="primary-btn cta-btn">Find Your Name</button>
        </div>
      </section>

      {/* Footer */}
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <h2 className="footer-logo">nns<span>.</span></h2>
            <p>The ultimate naming service for the Nimiq blockchain.</p>
          </div>
          <div className="footer-links">
            <div className="link-column">
              <h4>Ecosystem</h4>
              <a href="#">Nimiq Wallet</a>
              <a href="#">Cryptocity</a>
              <a href="#">Oasis</a>
            </div>
            <div className="link-column">
              <h4>Resources</h4>
              <a href="#">Documentation</a>
              <a href="#">Developer API</a>
              <a href="#">FAQ</a>
            </div>
            <div className="link-column">
              <h4>Community</h4>
              <a href="#">Twitter</a>
              <a href="#">Discord</a>
              <a href="#">GitHub</a>
            </div>
          </div>
        </div>
        <p className="footer-copyright">&copy; {new Date().getFullYear()} Nimiq Name Service. All rights reserved.</p>
      </footer>
    </div>
  )
}
