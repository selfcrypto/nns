/**
 * **My names** — the management screen. The list of what the identity set owns,
 * and, when a row is tapped, that name's card **in place**: repointing a name
 * you own never routes through a screen called Buy (docs/app-ux.md §3).
 */

import { useState, type ReactNode } from 'react'
import { CONSTANTS } from '@nimiqnames/core'
import { getOwnedNames, type OwnedName } from '../lib/api'
import { primaryAddress } from '../lib/identity'
import { approxDate, formatApproxWhen } from '../lib/format'
import { apiBase } from '../lib/nns'
import { search } from '../lib/search'
import { renewalUrgency, type AppAction } from '../lib/states'
import { useAsync } from '../lib/useAsync'
import { useRetryWhilePropagating } from '../lib/useRetryWhilePropagating'
import {
  OWNER_TILE,
  SCREEN_SUB,
  SCREEN_TITLE,
  backToNamesLabel,
  expiryUntilLine,
  graceBadge,
  myNamesEmptyAction,
  myNamesEmptyBody,
  myNamesEmptyTitle,
  myNamesNoWalletBody,
  myNamesNoWalletTitle,
  renewDueLine,
  unreachableLine,
} from '../lib/wording'
import type { Wallet } from '../lib/wallet'
import { IdentityBar } from '../components/IdentityBar'
import { NameCard, OWNER_ACTIONS } from '../components/NameCard'
import { TrustBar } from '../components/TrustBar'
import { Badge, Identicon, NameText, Spinner } from '../components/ui'
import styles from './mynames.module.css'

/** The header, the panel and the trust bar: the frame every state of the list shares. */
function NamesShell({ children }: { children: ReactNode }) {
  return (
    <div className={styles.lightThemeWrapper}>
      <div className={styles.heroSection}>
        <div className={styles.heroContent}>
          <div className={styles.namesHeader}>
            <div className={styles.titleRow}>
              <h2 className={styles.namesTitle}>{SCREEN_TITLE.names}</h2>
            </div>
            <p className={styles.namesSubtitle}>{SCREEN_SUB.names}</p>
          </div>
          <div className={styles.namesPanel}>{children}</div>
          <TrustBar screen="names" />
        </div>
      </div>
    </div>
  )
}

/** The acting address's names, alphabetical. Another connected address's names show once it is picked. */
async function ownedBy(address: string): Promise<{ names: readonly OwnedName[]; height: number }> {
  const page = await getOwnedNames(apiBase(), address)
  const names = [...page.names].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return { names, height: page.height }
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
  const retrying = useRetryWhilePropagating(outcome, () => setNonce((value) => value + 1))
  // The expiry badge is a shortcut into the tile it is about; the card owns the
  // sheet, so the request travels to it and is consumed there.
  const [requested, setRequested] = useState<AppAction | null>(null)

  const backLabel = backToNamesLabel()

  // The term badge in the top bar, off the same approximate dates every
  // other surface shows — the redesign printed an exact en-US date here.
  const nowMs = Date.now()
  const info = outcome.status === 'done' && outcome.value.kind === 'resolved' ? outcome.value.info : null
  //
  // Grace only, since 2026-09-15: the card's own status tag says "Yours until
  // ≈ date", or "Renew before ≈ date" inside the §10.4 window, so a second
  // badge with the same date above it was the screen saying one thing twice
  // — and it said "Renew before" whatever the urgency, which tells an owner
  // with two years left to renew. Grace is the one state the tag cannot
  // carry: the date that matters there is when the grace ends, not when the
  // term did.
  const badge =
    info === null || info.record === null || info.record.status !== 'GRACE'
      ? null
      : {
          grace: true,
          due: false,
          text: graceBadge(formatApproxWhen(approxDate(info.record.expiry + CONSTANTS.GRACE_PERIOD, info.height, nowMs), nowMs)),
        }

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
                {badge !== null && (
                  <button
                    type="button"
                    className={`${styles.expiryBadge} ${badge.grace ? styles.isGrace : badge.due ? styles.isDue : ''}`}
                    onClick={() => setRequested('renew')}
                    title={OWNER_TILE.renew.title}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    <span>{badge.text}</span>
                  </button>
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
                retrying={retrying}
                onPay={null}
                openAction={requested}
                onOpenActionHandled={() => setRequested(null)}
                seamless
              />
            )}
          </div>

          <TrustBar screen="names" />
        </div>
      </div>
    </div>
  )
}

export function MyNamesScreen({
  wallet,
  manage,
  onManageHandled,
  onConnect,
}: {
  wallet: Wallet | null
  /** A name Buy handed over; opens straight into its detail. */
  manage: string | null
  onManageHandled: () => void
  /** For the no-wallet card's own copy of the identity control. */
  onConnect: (() => void) | null
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [listNonce, setListNonce] = useState(0)
  const me = wallet === null ? null : primaryAddress(wallet.identity)
  const owned = useAsync(me === null ? null : () => ownedBy(me), [me, listNonce])

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

  if (me === null) {
    return (
      <NamesShell>
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
          {/* The identity control itself, not a second one: this card exists
              only while there is no wallet, which is the state IdentityBar
              draws as a lone Connect button, so there is never a panel to
              open. Saying "no wallet connected" and leaving the connect
              button in the masthead corner is a dead end that names its own
              cure — the landing page's cards send first-time readers straight
              here. Mounted only once detection has answered: while the
              wallet is still being looked for, the bar draws "Checking
              wallet…" and this card's own title already says there is none,
              which is a card arguing with itself. `detectWallet` always
              resolves — outside a WebView to the Hub — so the button is a
              moment late, never absent. */}
          {wallet !== null && (
            <IdentityBar wallet={wallet} onConnect={onConnect} onDisconnect={null} expanded={false} onToggle={() => {}} placement="empty" />
          )}
        </div>
      </NamesShell>
    )
  }

  if (owned.status === 'loading' || owned.status === 'idle') {
    return (
      <NamesShell>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
          <Spinner />
        </div>
      </NamesShell>
    )
  }

  if (owned.status === 'error') {
    return (
      <NamesShell>
        <p className="field-error">{unreachableLine()}</p>
      </NamesShell>
    )
  }

  const { names, height } = owned.value
  const nowMs = Date.now()

  return (
    <NamesShell>
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
          {/* The body has always named Buy; this performs it. A hash link,
              like the landing page's cards — the hash is the route. */}
          <a className={styles.emptyActionBtn} href="#/buy">
            {myNamesEmptyAction()}
          </a>
        </div>
      ) : (
        <ul className={styles.nameList}>
          {names.map((ownedName) => {
            const urgency = renewalUrgency(ownedName.expiry, height)
            const expiryDate = formatApproxWhen(approxDate(ownedName.expiry, height, nowMs), nowMs)
            const graceEnd = formatApproxWhen(approxDate(ownedName.expiry + CONSTANTS.GRACE_PERIOD, height, nowMs), nowMs)
            return (
              <li key={ownedName.name} className={styles.nameItem}>
                <button type="button" className={`name-row ${styles.nameRow}`} onClick={() => setSelected(ownedName.name)}>
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
    </NamesShell>
  )
}
