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
import { Badge, EmptyState, NameText, Spinner } from '../components/ui'

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

  return (
    <div className="screen">
      <button type="button" className="back-link" onClick={onBack}>
        {backToNamesLabel()}
      </button>
      {(outcome.status === 'loading' || outcome.status === 'idle') && <Spinner />}
      {outcome.status === 'error' && <p className="field-error">{unreachableLine()}</p>}
      {outcome.status === 'done' && (
        <NameCard
          outcome={outcome.value}
          wallet={wallet}
          nowMs={Date.now()}
          actions={OWNER_ACTIONS}
          onChanged={() => {
            setNonce((value) => value + 1)
            onChanged()
          }}
          // Already the destination: no handoff to offer.
          onManage={null}
          onPay={null}
        />
      )}
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
      <div className="screen">
        {/* No button here: connecting lives in the identity row above the tab
            bar, which is on screen right now. Two copies of one control is two
            controls that drift. */}
        <EmptyState title={myNamesNoWalletTitle()} body={myNamesNoWalletBody()} />
      </div>
    )
  }
  if (owned.status === 'loading' || owned.status === 'idle') {
    return (
      <div className="screen">
        <Spinner />
      </div>
    )
  }
  if (owned.status === 'error') {
    return (
      <div className="screen">
        <p className="field-error">{unreachableLine()}</p>
      </div>
    )
  }

  const { names, height } = owned.value
  const nowMs = Date.now()

  return (
    <div className="screen">
      {names.length === 0 ? (
        <EmptyState title={myNamesEmptyTitle()} body={myNamesEmptyBody()} />
      ) : (
        <ul className="name-list">
          {names.map((ownedName) => {
            const urgency = renewalUrgency(ownedName.expiry, height)
            const expiryDate = formatApproxDate(approxDate(ownedName.expiry, height, nowMs))
            const graceEnd = formatApproxDate(approxDate(ownedName.expiry + CONSTANTS.GRACE_PERIOD, height, nowMs))
            return (
              <li key={ownedName.name}>
                <button type="button" className="name-row" onClick={() => setSelected(ownedName.name)}>
                  <span className="name-row-name">
                    <NameText>{ownedName.name}</NameText>
                  </span>
                  <span className="name-row-meta">
                    {ownedName.status === 'GRACE' ? (
                      <Badge tone="grace">{graceBadge(graceEnd)}</Badge>
                    ) : urgency === 'due' ? (
                      <Badge tone="couldnt-check">{renewDueLine(expiryDate)}</Badge>
                    ) : (
                      <span className="name-row-expiry">{expiryUntilLine(expiryDate)}</span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
