/**
 * The identity row: the app's one statement of who it is acting as, and its
 * only connect and disconnect controls — previously spread across the masthead
 * and the foot of My Names, which is two copies of a control and therefore two
 * controls that drift (`NameCard.tsx` makes the same argument about the name
 * card).
 *
 * `placement` is where it sits, not a second control. `bottom` is the row above
 * the tab bar; `top` is the wallet connector in the masthead's right corner,
 * where the collapsed control is the address alone and everything else — the
 * rest of the set, Add another address, Disconnect — hangs under it. The corner
 * has room for one control, and the address is the one that has to be legible.
 * `empty` is inside My names' and the Inbox's "No wallet connected" card, which
 * exists only in the state this bar draws as a single Connect button: the card
 * named the missing wallet and left the fix in another corner of the screen,
 * and a dead end that states its own cure is still a dead end. It is the same
 * control, moved — not a second one, which is the whole reason this component
 * exists. All three read the same `identityRow`, so no state can exist in one
 * and not in the others.
 *
 * What it must never do, either way, is render nothing — a blank row and a
 * broken control look identical on a phone, and that is how a Pay session with
 * no way to disconnect went unreported for as long as it did. Every state below
 * draws something; `lib/states.ts`'s `identityRow` decides which, and is tested.
 */

import { identityRow } from '../lib/states'
import { ellipsizeAddress } from '../lib/format'
import { useConsensus, type Consensus } from '../lib/consensus'
import type { Wallet } from '../lib/wallet'
import {
  addAddressLabel,
  connectWalletLabel,
  consensusIconLabel,
  consensusOkLine,
  consensusSyncingLine,
  consensusUnknownLine,
  disconnectLabel,
  moreAddressesLabel,
  payConnectLabel,
  walletCheckingLine,
  showEveryAddressLabel
} from '../lib/wording'
import { NodeDot } from './icons'
import { Identicon } from './ui'

/**
 * The node light, in the panel where there is room for the sentence.
 *
 * Three states, never two: a request that never came back says nothing about
 * the node, so it reads as "could not reach" rather than as a red light. The
 * collapsed control gets the dot alone, since the corner has room for the
 * address and nothing else.
 */
function NodeLine({ consensus }: { consensus: Consensus }) {
  const state = consensus === true ? 'ok' : consensus === false ? 'syncing' : 'unknown'
  const line =
    consensus === true ? consensusOkLine() : consensus === false ? consensusSyncingLine() : consensusUnknownLine()
  return (
    <p className={`identity-node node-${state}`}>
      <NodeDot />
      {line}
    </p>
  )
}

export type IdentityPlacement = 'top' | 'bottom' | 'empty'

export function IdentityBar({
  wallet,
  onConnect,
  onDisconnect,
  expanded,
  onToggle,
  placement = 'bottom',
}: {
  wallet: Wallet | null
  onConnect: (() => void) | null
  onDisconnect: (() => void) | null
  expanded: boolean
  onToggle: () => void
  placement?: IdentityPlacement
}) {
  const row = identityRow(wallet)
  const consensus = useConsensus()
  const top = placement === 'top'
  const bar = `identity-bar identity-${placement}`

  if (row.kind === 'checking') {
    return (
      <div className={bar}>
        <span className="identity-note">{walletCheckingLine()}</span>
      </div>
    )
  }

  if (row.kind === 'connect') {
    if (onConnect === null) return null
    return (
      <div className={bar}>
        <button type="button" className="connect identity-connect" onClick={onConnect}>
          {/* In the corner the label is what fits beside the wordmark; the row
              above the tab bar has the width to name the host it will ask. */}
          {top ? connectWalletLabel() : row.host === 'pay' ? payConnectLabel() : connectWalletLabel()}
        </button>
      </div>
    )
  }

  const addresses = wallet?.identity.addresses ?? []
  const disconnect = row.canDisconnect && onDisconnect !== null ? onDisconnect : null
  const add = row.canAdd && onConnect !== null ? onConnect : null
  // Top: the address is the whole collapsed control, so the panel is the only
  // place the other controls exist and it must open even for a lone address.
  // Bottom: Disconnect is already on the row, and the panel is the rest of the set.
  const hasPanel = top ? disconnect !== null || add !== null || row.more > 0 : row.more > 0 || add !== null

  return (
    <div className={bar}>
      {/* A tap anywhere else closes the panel. Only at the top, where it hangs
          over the screen rather than pushing it. */}
      {top && expanded && <button type="button" className="identity-scrim" aria-label="Close" onClick={onToggle} />}
      <div className="identity-main">
        <button
          type="button"
          className="identity-who"
          onClick={onToggle}
          aria-expanded={expanded}
          disabled={!hasPanel}
          // The set is the identity (`lib/identity.ts`); the primary is just
          // the one that fits. Everything else is one tap away rather than
          // invisible.
          title={row.more > 0 ? showEveryAddressLabel() : undefined}
        >
          <Identicon address={row.primary} size={22} />
          <span className="identity-address nns-name">{ellipsizeAddress(row.primary)}</span>
          {/* Collapsed: the dot only, and only once the node has actually
              answered. An unlit corner is the honest state for "we have not
              heard back", and a grey dot there would just be furniture. */}
          {consensus === true && (
            <span className="identity-light node-ok" title={consensusIconLabel()} aria-label={consensusIconLabel()}>
              <NodeDot />
            </span>
          )}
          {row.more > 0 && <span className="identity-more">{moreAddressesLabel(row.more)}</span>}
        </button>
        {/* Bottom only: Disconnect stays on the collapsed row — it is the
            control that was missing, and one a user should not have to go
            looking for. "Add another address" moves below: two buttons here
            squeezed the address down to "NQ0…", and the address is the point of
            the row. In the corner there is room for neither, so both live in
            the panel. */}
        {!top && disconnect !== null && (
          <button type="button" className="connect connect-quiet identity-action" onClick={disconnect}>
            {disconnectLabel()}
          </button>
        )}
      </div>
      {expanded && hasPanel && (
        <div className="identity-expanded">
          <NodeLine consensus={consensus} />
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
          {add !== null && (
            <button type="button" className="connect connect-quiet identity-add" onClick={add}>
              {addAddressLabel()}
            </button>
          )}
          {top && disconnect !== null && (
            <button type="button" className="connect connect-quiet identity-add" onClick={disconnect}>
              {disconnectLabel()}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
