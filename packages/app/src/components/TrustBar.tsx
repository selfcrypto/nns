import type { ReactNode } from 'react'
import { TRUST_CLAIM, TRUST_CLAIMS, type AppScreen, type TrustClaim } from '../lib/wording'

/**
 * The three-claim line under every screen's panel, from the redesign. One
 * component, because the five copies it replaces were identical to the
 * pixel and the Inbox's scroll code went looking for one by a hashed
 * module class name. The claims are `wording.ts`'s, per screen; the
 * pictograms are here, one per claim.
 */

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

const ICON: Record<TrustClaim, ReactNode> = {
  onChain: <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
  onChainSettlement: <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
  selfCustody: (
    <>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  merkleVerified: (
    <>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  walletSigned: (
    <>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  zeroContracts: (
    <>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </>
  ),
  zeroIntermediaries: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </>
  ),
  decentralizedChat: (
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  ),
  publicAuditLog: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="16" y2="17" />
    </>
  ),
  antiSniping: (
    <>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </>
  ),
}

export function TrustBar({ screen }: { screen: AppScreen }) {
  return (
    <div className="trust-bar">
      {TRUST_CLAIMS[screen].map((claim, index) => (
        <span key={claim} className="trust-item-wrap">
          {index > 0 && (
            <span className="trust-dot" aria-hidden="true">
              •
            </span>
          )}
          <span className="trust-item">
            <svg className="trust-icon" width="16" height="16" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
              {ICON[claim]}
            </svg>
            <span>{TRUST_CLAIM[claim]}</span>
          </span>
        </span>
      ))}
    </div>
  )
}
