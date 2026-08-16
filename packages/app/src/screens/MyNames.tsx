import { CONSTANTS } from '@nns/core'
import { getOwnedNames } from '../lib/api'
import { approxDate, formatApproxDate } from '../lib/format'
import { apiBase } from '../lib/nns'
import { renewalUrgency } from '../lib/states'
import { useAsync } from '../lib/useAsync'
import { graceBadge, renewDueLine, unreachableLine } from '../lib/wording'
import { Badge, EmptyState, NameText, Spinner } from '../components/ui'

export function MyNamesScreen({ viewer, onOpen }: { viewer: string | null; onOpen: (name: string) => void }) {
  const owned = useAsync(viewer === null ? null : () => getOwnedNames(apiBase(), viewer), [viewer])

  if (viewer === null) {
    return (
      <div className="screen">
        <EmptyState
          title="Open in Nimiq Pay"
          body="Your names are listed by your wallet address, and there’s no wallet here."
        />
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

  if (names.length === 0) {
    return (
      <div className="screen">
        <EmptyState title="No names yet" body="Find a free name in Search — it points at your address the moment it’s registered." />
      </div>
    )
  }

  return (
    <div className="screen">
      <ul className="name-list">
        {names.map((owned) => {
          const urgency = renewalUrgency(owned.expiry, height)
          const expiryDate = formatApproxDate(approxDate(owned.expiry, height, nowMs))
          const graceEnd = formatApproxDate(approxDate(owned.expiry + CONSTANTS.GRACE_PERIOD, height, nowMs))
          return (
            <li key={owned.name}>
              <button type="button" className="name-row" onClick={() => onOpen(owned.name)}>
                <span className="name-row-name">
                  <NameText>{owned.name}</NameText>
                </span>
                <span className="name-row-meta">
                  {owned.status === 'GRACE' ? (
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
    </div>
  )
}
