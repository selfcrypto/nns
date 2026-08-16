import { useState } from 'react'
import { checkAndPin, overridePin, pinStore, type PinVerdict } from '../lib/pinning'
import { useAsync } from '../lib/useAsync'
import {
  pinCurrentLabel,
  pinFirstUseLine,
  pinMismatchBody,
  pinMismatchTitle,
  pinOverrideConfirmLabel,
  pinOverrideLabel,
  pinPreviousLabel,
} from '../lib/wording'
import { Identicon } from './ui'

/**
 * The §8.5 pin check, run on every resolved answer shown (states doc §2).
 * Match and unchecked render nothing — silence is the feature. The override
 * is deliberately two-step: one tap to reveal the real button, one to act.
 */
export function PinCheck({ query, address }: { query: string; address: string }) {
  const [overridden, setOverridden] = useState(false)
  const verdict = useAsync<PinVerdict>(
    overridden ? null : () => checkAndPin(pinStore(), query, address, Date.now()),
    [query, address, overridden],
  )

  if (overridden || verdict.status !== 'done') return null

  switch (verdict.value.kind) {
    case 'match':
    case 'unchecked':
      return null
    case 'first-use':
      return <p className="note note-info">{pinFirstUseLine()}</p>
    case 'mismatch':
      return (
        <PinMismatch
          query={query}
          address={address}
          pinnedAddress={verdict.value.pinned.address}
          pinnedAt={verdict.value.pinned.pinnedAt}
          onOverridden={() => setOverridden(true)}
        />
      )
  }
}

function PinMismatch({
  query,
  address,
  pinnedAddress,
  pinnedAt,
  onOverridden,
}: {
  query: string
  address: string
  pinnedAddress: string
  pinnedAt: number
  onOverridden: () => void
}) {
  const [armed, setArmed] = useState(false)

  return (
    <div className="pin-mismatch" role="alert">
      <h3 className="alarm-title">{pinMismatchTitle()}</h3>
      {/* The pin time is exact device-local time, so no ≈ estimate form here. */}
      <p>{pinMismatchBody(query, new Date(pinnedAt).toLocaleDateString())}</p>
      <div className="pin-compare">
        <div className="pin-side">
          <span className="pin-side-label">{pinPreviousLabel()}</span>
          <Identicon address={pinnedAddress} size={32} />
          <span className="address nns-name">{pinnedAddress}</span>
        </div>
        <div className="pin-side">
          <span className="pin-side-label">{pinCurrentLabel()}</span>
          <Identicon address={address} size={32} />
          <span className="address nns-name">{address}</span>
        </div>
      </div>
      {!armed ? (
        <button type="button" className="pin-override" onClick={() => setArmed(true)}>
          {pinOverrideLabel()}
        </button>
      ) : (
        <button
          type="button"
          className="pin-override pin-override-armed"
          onClick={() => {
            void overridePin(pinStore(), query, address, Date.now()).finally(onOverridden)
          }}
        >
          {pinOverrideConfirmLabel()}
        </button>
      )}
    </div>
  )
}
