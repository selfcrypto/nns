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
 * connected addresses, Add another address, Disconnect — hangs under it.
 *
 * It is also the **switch**: the app acts as one address (`lib/identity.ts`),
 * and tapping another in the list makes that one the acting address. The
 * list looked like a switch and switched nothing until 2026-09-18. The corner
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

import { identityRow, mostHeld } from '../lib/states'
import { ellipsizeAddress, lunaToNimShort } from '../lib/format'
import { defaultTransport, fetchNimBalance } from '../lib/history'
import { useAsync } from '../lib/useAsync'
import type { Wallet } from '../lib/wallet'
import {
  addAddressLabel,
  connectWalletLabel,
  disconnectLabel,
  moreAddressesLabel,
  nimAmountLine,
  notifyLabel,
  payConnectLabel,
  walletHoldsLine,
  walletCheckingLine,
  showEveryAddressLabel
} from '../lib/wording'
import { Identicon } from './ui'

export type IdentityPlacement = 'top' | 'bottom' | 'empty'

export function IdentityBar({
  wallet,
  onConnect,
  onDisconnect,
  onPick = null,
  onNotify = null,
  expanded,
  onToggle,
  placement = 'bottom',
}: {
  wallet: Wallet | null
  onConnect: (() => void) | null
  onDisconnect: (() => void) | null
  /** Make an address the acting one. Null where there is no list to pick from. */
  onPick?: ((address: string) => void) | null
  /** Open the notifications sheet for the acting address (tasks/26). Null when no notifier is configured, and nothing is drawn. */
  onNotify?: ((address: string) => void) | null
  expanded: boolean
  onToggle: () => void
  placement?: IdentityPlacement
}) {
  const row = identityRow(wallet)
  const top = placement === 'top'
  const bar = `identity-bar identity-${placement}`
  const addresses = wallet?.identity.addresses ?? []

  // The corner panel says what each address holds, asked once per opening:
  // whether the wallet can pay for a name should be one glance, on any screen
  // (Rico, 2026-09-22). A list gets a figure per row; a lone address gets one
  // line, read the way the sheets read it (`Wallet.balanceAddresses`,
  // `mostHeld`). Display-only, and a miss hides the figure rather than
  // showing a zero.
  const listed = addresses.length > 1
  const payers = wallet === null ? [] : listed ? addresses : wallet.balanceAddresses.length > 0 ? wallet.balanceAddresses : addresses
  const payersKey = payers.join(',')
  const balances = useAsync(
    top && expanded && payers.length > 0
      ? async (): Promise<ReadonlyMap<string, bigint | null>> => {
          const transport = defaultTransport()
          if (transport === null) return new Map()
          const found = await Promise.all(payers.map((address) => fetchNimBalance(transport, address)))
          return new Map(payers.map((address, index) => [address, found[index] ?? null]))
        }
      : null,
    [top, expanded, payersKey],
  )
  const balanceOf = (address: string): bigint | null => (balances.status === 'done' ? (balances.value.get(address) ?? null) : null)
  const held = balances.status === 'done' && !listed ? mostHeld(payers.map((address) => balances.value.get(address) ?? null)) : null

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

  const disconnect = row.canDisconnect && onDisconnect !== null ? onDisconnect : null
  const add = row.canAdd && onConnect !== null ? onConnect : null
  // Top: the address is the whole collapsed control, so the panel is the only
  // place the other controls exist and it must open even for a lone address.
  // Bottom: Disconnect is already on the row, and the panel is the rest of the set.
  const hasPanel = top ? disconnect !== null || add !== null || onNotify !== null || row.more > 0 : row.more > 0 || add !== null || onNotify !== null

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
          // The acting address. The others are one tap away, in the panel,
          // and picking one there makes it this.
          title={row.more > 0 ? showEveryAddressLabel() : undefined}
        >
          <Identicon address={row.primary} size={22} />
          <span className="identity-address nns-name">{ellipsizeAddress(row.primary)}</span>
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
          {held !== null && <p className="identity-balance-line">{walletHoldsLine(lunaToNimShort(held))}</p>}
          {row.more > 0 && (
            <ul className="identity-list">
              {addresses.map((address) => {
                const acting = address === row.primary
                return (
                  <li key={address}>
                    <button
                      type="button"
                      className="identity-pick"
                      aria-current={acting ? 'true' : undefined}
                      disabled={onPick === null}
                      onClick={() => onPick?.(address)}
                    >
                      <Identicon address={address} size={18} />
                      <span className="identity-address nns-name">{ellipsizeAddress(address)}</span>
                      {balanceOf(address) !== null && <span className="identity-balance">{nimAmountLine(lunaToNimShort(balanceOf(address) ?? 0n))}</span>}
                      {acting && (
                        <svg className="identity-pick-mark" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {/* The acting address's notifications. The list above is the switch,
              so one row covers every address: pick, then open. */}
          {onNotify !== null && (
            <button type="button" className="connect connect-quiet identity-add identity-notify" onClick={() => onNotify(row.primary)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              {notifyLabel()}
            </button>
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
