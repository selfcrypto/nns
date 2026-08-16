/**
 * Identity is a **set of addresses** (the recorded two-adapter intent, now
 * live): Nimiq Pay supplies a set of one with no connect step; Nimiq Hub
 * grows the set one `chooseAddress` at a time. "My names" is the union
 * across the set, and every owner action knows which address signs.
 */

import { formatAddress, tryParseAddress } from '@nns/core'

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
