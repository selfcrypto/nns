/**
 * The identity row, above the tab bar and below the screen.
 *
 * The app's one statement of who it is acting as, and its only connect and
 * disconnect controls — previously spread across the masthead and the foot of
 * My Names, which is two copies of a control and therefore two controls that
 * drift (`NameCard.tsx` makes the same argument about the name card).
 *
 * It lives at the bottom on Kike's call (2026-08-22): it is the row a thumb
 * reaches, and it is nowhere near a host's chrome. What it must never do is
 * render nothing — a blank row and a broken control look identical on a phone,
 * and that is how a Pay session with no way to disconnect went unreported for
 * as long as it did. Every state below draws something; `lib/states.ts`'s
 * `identityRow` decides which, and is tested.
 */

import { identityRow } from '../lib/states'
import { ellipsizeAddress } from '../lib/format'
import type { Wallet } from '../lib/wallet'
import {
  addAddressLabel,
  connectWalletLabel,
  disconnectLabel,
  moreAddressesLabel,
  payConnectLabel,
  walletCheckingLine,
} from '../lib/wording'
import { Identicon } from './ui'

export function IdentityBar({
  wallet,
  onConnect,
  onDisconnect,
  expanded,
  onToggle,
}: {
  wallet: Wallet | null
  onConnect: (() => void) | null
  onDisconnect: (() => void) | null
  expanded: boolean
  onToggle: () => void
}) {
  const row = identityRow(wallet)

  if (row.kind === 'checking') {
    return (
      <div className="identity-bar">
        <span className="identity-note">{walletCheckingLine()}</span>
      </div>
    )
  }

  if (row.kind === 'connect') {
    if (onConnect === null) return null
    return (
      <div className="identity-bar">
        <button type="button" className="connect identity-connect" onClick={onConnect}>
          {row.host === 'pay' ? payConnectLabel() : connectWalletLabel()}
        </button>
      </div>
    )
  }

  const addresses = wallet?.identity.addresses ?? []

  return (
    <div className="identity-bar">
      <div className="identity-main">
        <button
          type="button"
          className="identity-who"
          onClick={onToggle}
          aria-expanded={expanded}
          // The set is the identity (`lib/identity.ts`); the primary is just
          // the one that fits. Everything else is one tap away rather than
          // invisible.
          title={row.more > 0 ? 'Show every address' : undefined}
        >
          <Identicon address={row.primary} size={22} />
          <span className="identity-address nns-name">{ellipsizeAddress(row.primary)}</span>
          {row.more > 0 && <span className="identity-more">{moreAddressesLabel(row.more)}</span>}
        </button>
        {/* Disconnect stays on the collapsed row — it is the control that was
            missing, and one a user should not have to go looking for. "Add
            another address" moves below: two buttons here squeezed the address
            down to "NQ0…", and the address is the point of the row. */}
        {row.canDisconnect && onDisconnect !== null && (
          <button type="button" className="connect connect-quiet identity-action" onClick={onDisconnect}>
            {disconnectLabel()}
          </button>
        )}
      </div>
      {expanded && (
        <div className="identity-expanded">
          {row.more > 0 && (
            <ul className="identity-list">
              {addresses.map((address) => (
                <li key={address}>
                  <Identicon address={address} size={18} />
                  <span className="identity-address nns-name">{ellipsizeAddress(address)}</span>
                </li>
              ))}
            </ul>
          )}
          {row.canAdd && onConnect !== null && (
            <button type="button" className="connect connect-quiet identity-add" onClick={onConnect}>
              {addAddressLabel()}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
