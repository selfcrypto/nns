/**
 * Identity is a **set of addresses** (the recorded two-adapter intent, now
 * live): Nimiq Pay supplies a set of one with no connect step; Nimiq Hub
 * grows the set one `chooseAddress` at a time. "My names" is the union
 * across the set, and every owner action knows which address signs.
 */

import { formatAddress, tryParseAddress } from '@nimiqnames/core'

export type WalletKind = 'pay' | 'hub' | 'none'

export interface Identity {
  readonly kind: WalletKind
  readonly addresses: readonly string[]
}

export const NO_IDENTITY: Identity = { kind: 'none', addresses: [] }

/** Canonical spaced form (what the API serves), or null — every address entering the set goes through this. */
export function canonicalAddress(input: string): string | null {
  const parsed = tryParseAddress(input)
  return parsed === null ? null : formatAddress(parsed)
}

export function withAddress(addresses: readonly string[], input: string): readonly string[] {
  const canonical = canonicalAddress(input)
  if (canonical === null || addresses.includes(canonical)) return addresses
  return [...addresses, canonical]
}

export function primaryAddress(identity: Identity): string | null {
  return identity.addresses[0] ?? null
}

// ── Hub set persistence (per device, like the pins; best-effort) ───────────

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const HUB_KEY = 'nns.hub.addresses'

export function loadHubAddresses(storage: StorageLike): readonly string[] {
  let raw: string | null
  try {
    raw = storage.getItem(HUB_KEY)
  } catch {
    return []
  }
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const addresses: string[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue
    const canonical = canonicalAddress(entry)
    if (canonical !== null && !addresses.includes(canonical)) addresses.push(canonical)
  }
  return addresses
}

export function saveHubAddresses(storage: StorageLike, addresses: readonly string[]): void {
  try {
    storage.setItem(HUB_KEY, JSON.stringify(addresses))
  } catch {
    // Best-effort, like every per-device store here.
  }
}

/**
 * Forget the set, so the next connect can choose a different address. Written
 * as an empty list rather than removed: `StorageLike` is deliberately the two
 * methods this module needs, and `loadHubAddresses` reads `[]` back as no
 * addresses either way.
 */
export function clearHubAddresses(storage: StorageLike): void {
  saveHubAddresses(storage, [])
}

// ── Pay dismissal (per device, same best-effort store) ─────────────────────

const PAY_DISMISSED_KEY = 'nns.pay.dismissed'

/**
 * Whether the user has told *this app* to stop using Nimiq Pay's accounts.
 *
 * Pay hands its account set over with no prompt and no revocation, so there is
 * nothing in Pay to disconnect from — which is why the Pay adapter shipped with
 * `connect` and `disconnect` both null, and why a user who had connected could
 * find no way back out (Kike, 2026-08-22). This flag is that way out, and it is
 * honest about its scope: it drops the addresses from the app's identity on
 * this device. It revokes nothing in the wallet, and the wording must not claim
 * it does.
 */
export function loadPayDismissed(storage: StorageLike): boolean {
  try {
    return storage.getItem(PAY_DISMISSED_KEY) === '1'
  } catch {
    // A broken store reads as "not dismissed" — the same direction
    // `hidden.ts` fails in: never hide something the user did not hide.
    return false
  }
}

export function savePayDismissed(storage: StorageLike, dismissed: boolean): void {
  try {
    storage.setItem(PAY_DISMISSED_KEY, dismissed ? '1' : '0')
  } catch {
    // Best-effort, like every per-device store here.
  }
}
