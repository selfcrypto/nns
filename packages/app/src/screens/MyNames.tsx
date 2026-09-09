/**
 * **My names** — the management screen. The list of what the identity set owns,
 * and, when a row is tapped, that name's card **in place**: repointing a name
 * you own never routes through a screen called Buy (docs/app-ux.md §3).
 */

import { useState } from 'react'
import { CONSTANTS } from '@nns/core'
import { getOwnedNames, type OwnedName } from '../lib/api'
import { approxDate, formatApproxDate } from '../lib/format'
import { apiBase } from '../lib/nns'
import { search } from '../lib/search'
import { renewalUrgency } from '../lib/states'
import { useAsync } from '../lib/useAsync'
import {
  backToNamesLabel,
  expiryUntilLine,
  graceBadge,
  myNamesEmptyBody,
  myNamesEmptyTitle,
  myNamesNoWalletBody,
  myNamesNoWalletTitle,
  renewDueLine,
  unreachableLine,
} from '../lib/wording'
import type { Wallet } from '../lib/wallet'
import { NameCard, OWNER_ACTIONS } from '../components/NameCard'
import { Badge, Identicon, NameText, Spinner } from '../components/ui'
import styles from './mynames.module.css'

function TrustBar() {
  return (
    <div className={styles.trustBar}>
      <div className={styles.trustItem}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={styles.trustIcon} aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <span>100% On-Chain</span>
      </div>
      <span className={styles.trustDot} aria-hidden="true">•</span>
      <div className={styles.trustItem}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={styles.trustIcon} aria-hidden="true">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
        <span>Self-Custody</span>
      </div>
      <span className={styles.trustDot} aria-hidden="true">•</span>
      <div className={styles.trustItem}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={styles.trustIcon} aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
        </svg>
        <span>Zero Intermediaries</span>
      </div>
    </div>
  )
}

/** "My names" is the union across the identity set (a name belongs to exactly one owner, so no dedupe). */
async function unionOwned(viewers: readonly string[]): Promise<{ names: readonly OwnedName[]; height: number }> {
  const pages = await Promise.all(viewers.map((address) => getOwnedNames(apiBase(), address)))
  const names = pages
    .flatMap((page) => page.names)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return { names, height: pages[0]?.height ?? 0 }
}

/** The selected name's card, fed exactly as Buy feeds it — one card, two screens. */
function Detail({
  name,
  wallet,
  onBack,
  onChanged,
}: {
  name: string
  wallet: Wallet | null
  onBack: () => void
  onChanged: () => void
}) {
  const [nonce, setNonce] = useState(0)
  const outcome = useAsync(() => search(name), [name, nonce])

  const backLabel = backToNamesLabel().replace(/^‹\s*/, '')

  // Extract expiry status for the top bar
  const record = outcome.status === 'done' && outcome.value.kind === 'resolved' ? outcome.value.info?.record ?? null : null
  const height = outcome.status === 'done' && outcome.value.kind === 'resolved' ? outcome.value.info?.height ?? null : null
  const nowMs = Date.now()
  const urgency = record && height ? renewalUrgency(record.expiry, height) : null
  const approxExpiry = record && height ? approxDate(record.expiry, height, nowMs) : null
  const expiryDate = approxExpiry
    ? approxExpiry.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : null
  const graceEnd = record && height ? formatApproxDate(approxDate(record.expiry + CONSTANTS.GRACE_PERIOD, height, nowMs)) : null

  return (
    <div className={styles.lightThemeWrapper}>
      <div className={styles.heroSection}>
        <div className={styles.heroContent}>
          <div className={`${styles.namesPanel} ${styles.detailCard}`}>
            <div className={styles.detailNav}>
              <button type="button" className={styles.backBtn} onClick={onBack} aria-label={backLabel} title={backLabel}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="19" y1="12" x2="5" y2="12" />
                  <polyline points="12 19 5 12 12 5" />
                </svg>
                <span className={styles.backBtnText}>{backLabel}</span>
              </button>

              <div className={styles.detailNavRight}>
                {record && (
                  <div
                    className={`${styles.expiryBadge} ${
                      record.status === 'GRACE' ? styles.isGrace : urgency === 'due' ? styles.isDue : ''
                    }`}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    <span>
                      {record.status === 'GRACE'
                        ? graceBadge(graceEnd ?? '')
                        : `Renew by ${expiryDate}`}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {(outcome.status === 'loading' || outcome.status === 'idle') && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '50px 0' }}>
                <Spinner />
              </div>
            )}
            {outcome.status === 'error' && <p className="field-error">{unreachableLine()}</p>}
            {outcome.status === 'done' && (
              <NameCard
                outcome={outcome.value}
                wallet={wallet}
                nowMs={nowMs}
                actions={OWNER_ACTIONS}
                onChanged={() => {
                  setNonce((value) => value + 1)
                  onChanged()
                }}
                // Already the destination: no handoff to offer.
                onManage={null}
                onPay={null}
                seamless
              />
            )}
          </div>

          <TrustBar />
        </div>
      </div>
    </div>
  )
}

export function MyNamesScreen({
  wallet,
  manage,
  onManageHandled,
}: {
  wallet: Wallet | null
  /** A name Buy handed over; opens straight into its detail. */
  manage: string | null
  onManageHandled: () => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [listNonce, setListNonce] = useState(0)
  const viewers = wallet?.identity.addresses ?? []
  const owned = useAsync(viewers.length === 0 ? null : () => unionOwned(viewers), [viewers.join(' '), listNonce])

  const open = manage ?? selected
  if (open !== null) {
    return (
      <Detail
        name={open}
        wallet={wallet}
        onBack={() => {
          setSelected(null)
          onManageHandled()
        }}
        onChanged={() => setListNonce((value) => value + 1)}
      />
    )
  }

  if (viewers.length === 0) {
    return (
      <div className={styles.lightThemeWrapper}>
        <div className={styles.heroSection}>
          <div className={styles.heroContent}>
            <div className={styles.namesHeader}>
              <div className={styles.titleRow}>
                <h2 className={styles.namesTitle}>My Names</h2>
              </div>
              <p className={styles.namesSubtitle}>Manage your on-chain identities, records, and marketplace listings</p>
            </div>
            <div className={styles.namesPanel}>
              <div className={styles.emptyCard}>
                <div className={styles.emptyIcon} aria-hidden="true">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
                    <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
                    <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
                  </svg>
                </div>
                <h3 className={styles.emptyTitle}>{myNamesNoWalletTitle()}</h3>
                <p className={styles.emptyBody}>{myNamesNoWalletBody()}</p>
              </div>
            </div>
            <TrustBar />
          </div>
        </div>
      </div>
    )
  }

  if (owned.status === 'loading' || owned.status === 'idle') {
    return (
      <div className={styles.lightThemeWrapper}>
        <div className={styles.heroSection}>
          <div className={styles.heroContent}>
            <div className={styles.namesHeader}>
              <div className={styles.titleRow}>
                <h2 className={styles.namesTitle}>My Names</h2>
              </div>
              <p className={styles.namesSubtitle}>Manage your on-chain identities, records, and marketplace listings</p>
            </div>
            <div className={styles.namesPanel}>
              <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
                <Spinner />
              </div>
            </div>
            <TrustBar />
          </div>
        </div>
      </div>
    )
  }

  if (owned.status === 'error') {
    return (
      <div className={styles.lightThemeWrapper}>
        <div className={styles.heroSection}>
          <div className={styles.heroContent}>
            <div className={styles.namesHeader}>
              <div className={styles.titleRow}>
                <h2 className={styles.namesTitle}>My Names</h2>
              </div>
              <p className={styles.namesSubtitle}>Manage your on-chain identities, records, and marketplace listings</p>
            </div>
            <div className={styles.namesPanel}>
              <p className="field-error">{unreachableLine()}</p>
            </div>
            <TrustBar />
          </div>
        </div>
      </div>
    )
  }

  const { names, height } = owned.value
  const nowMs = Date.now()

  return (
    <div className={styles.lightThemeWrapper}>
      <div className={styles.heroSection}>
        <div className={styles.heroContent}>
          <div className={styles.namesHeader}>
            <div className={styles.titleRow}>
              <h2 className={styles.namesTitle}>My Names</h2>
            </div>
            <p className={styles.namesSubtitle}>Manage your on-chain identities, records, and marketplace listings</p>
          </div>

          <div className={styles.namesPanel}>
            {names.length === 0 ? (
              <div className={styles.emptyCard}>
                <div className={styles.emptyIcon} aria-hidden="true">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                    <line x1="7" y1="7" x2="7.01" y2="7" />
                  </svg>
                </div>
                <h3 className={styles.emptyTitle}>{myNamesEmptyTitle()}</h3>
                <p className={styles.emptyBody}>{myNamesEmptyBody()}</p>
              </div>
            ) : (
              <ul className={styles.nameList}>
                {names.map((ownedName) => {
                  const urgency = renewalUrgency(ownedName.expiry, height)
                  const expiryDate = formatApproxDate(approxDate(ownedName.expiry, height, nowMs))
                  const graceEnd = formatApproxDate(approxDate(ownedName.expiry + CONSTANTS.GRACE_PERIOD, height, nowMs))
                  return (
                    <li key={ownedName.name} className={styles.nameItem}>
                      <button type="button" className={styles.nameRow} onClick={() => setSelected(ownedName.name)}>
                        <div className={styles.nameAvatar}>
                          {ownedName.target ? (
                            <Identicon address={ownedName.target} size={36} />
                          ) : (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--nimiq-blue)' }} aria-hidden="true">
                              <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                              <line x1="7" y1="7" x2="7.01" y2="7" />
                            </svg>
                          )}
                        </div>
                        <div className={styles.nameInfo}>
                          <span className={styles.nameHeading}>
                            <NameText>{ownedName.name}</NameText>
                          </span>
                          <div className={styles.nameMeta}>
                            {ownedName.status === 'GRACE' ? (
                              <Badge tone="grace">{graceBadge(graceEnd)}</Badge>
                            ) : urgency === 'due' ? (
                              <Badge tone="couldnt-check">{renewDueLine(expiryDate)}</Badge>
                            ) : (
                              <span className={styles.expiryText}>{expiryUntilLine(expiryDate)}</span>
                            )}
                          </div>
                        </div>
                        <svg className={styles.chevronIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <TrustBar />
        </div>
      </div>
    </div>
  )
}
