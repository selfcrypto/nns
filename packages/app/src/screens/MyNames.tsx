import { CONSTANTS } from '@nns/core'
import { getOwnedNames, type OwnedName } from '../lib/api'
import { approxDate, formatApproxDate } from '../lib/format'
import { apiBase } from '../lib/nns'
import { renewalUrgency } from '../lib/states'
import { useAsync } from '../lib/useAsync'
import { addAddressLabel, connectHubLabel, graceBadge, renewDueLine, unreachableLine } from '../lib/wording'
import type { Wallet } from '../lib/wallet'
import { Badge, EmptyState, NameText, Spinner } from '../components/ui'

/** "My names" is the union across the identity set (a name belongs to exactly one owner, so no dedupe). */
async function unionOwned(viewers: readonly string[]): Promise<{ names: readonly OwnedName[]; height: number }> {
  const pages = await Promise.all(viewers.map((address) => getOwnedNames(apiBase(), address)))
  const names = pages
    .flatMap((page) => page.names)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return { names, height: pages[0]?.height ?? 0 }
}

export function MyNamesScreen({
  wallet,
  onOpen,
  onConnect,
}: {
  wallet: Wallet | null
  onOpen: (name: string) => void
  onConnect: (() => void) | null
}) {
  const viewers = wallet?.identity.addresses ?? []
  const owned = useAsync(viewers.length === 0 ? null : () => unionOwned(viewers), [viewers.join(' ')])

  if (viewers.length === 0) {
    return (
      <div className="screen">
        <EmptyState
          title={onConnect !== null ? 'Connect a wallet' : 'Open in Nimiq Pay'}
          body="Your names are listed by your wallet addresses."
        />
        {onConnect !== null && (
          <button type="button" className="connect" onClick={onConnect}>
            {connectHubLabel()}
          </button>
        )}
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
        <EmptyState title="No names yet" body="Find a free name in Search — it points at your address the moment it’s registered." />
      ) : (
        <ul className="name-list">
          {names.map((ownedName) => {
            const urgency = renewalUrgency(ownedName.expiry, height)
            const expiryDate = formatApproxDate(approxDate(ownedName.expiry, height, nowMs))
            const graceEnd = formatApproxDate(approxDate(ownedName.expiry + CONSTANTS.GRACE_PERIOD, height, nowMs))
            return (
              <li key={ownedName.name}>
                <button type="button" className="name-row" onClick={() => onOpen(ownedName.name)}>
                  <span className="name-row-name">
                    <NameText>{ownedName.name}</NameText>
                  </span>
                  <span className="name-row-meta">
                    {ownedName.status === 'GRACE' ? (
                      <Badge tone="grace">{graceBadge(graceEnd)}</Badge>
                    ) : urgency === 'due' ? (
                      <Badge tone="couldnt-check">{renewDueLine(expiryDate)}</Badge>
                    ) : (
                      <span className="name-row-expiry">until {expiryDate}</span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {onConnect !== null && (
        <button type="button" className="connect connect-quiet" onClick={onConnect}>
          {addAddressLabel()}
        </button>
      )}
    </div>
  )
}
