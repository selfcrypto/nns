/**
 * Hidden senders — the spam answer `docs/app-chat.md` §5 asks for, and the
 * per-conversation action `docs/app-ux.md` §3 has specified all along.
 *
 * Device-local and best-effort, exactly like the Hub address set in
 * `identity.ts`: nothing about who a reader chooses to ignore belongs on a
 * chain or on a server. A broken store answers "nothing hidden" rather than
 * throwing — failing closed would silence conversations the reader never
 * hid, which is the worse of the two failures.
 */

import { canonicalAddress, type StorageLike } from './identity'

const HIDDEN_KEY = 'nns.chat.hidden'

export function loadHiddenSenders(storage: StorageLike): readonly string[] {
  let raw: string | null
  try {
    raw = storage.getItem(HIDDEN_KEY)
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

function save(storage: StorageLike, addresses: readonly string[]): void {
  try {
    storage.setItem(HIDDEN_KEY, JSON.stringify(addresses))
  } catch {
    // Best-effort, like every per-device store here.
  }
}

/** Returns the new list, so a caller can set state without re-reading. */
export function hideSender(storage: StorageLike, address: string): readonly string[] {
  const canonical = canonicalAddress(address)
  const current = loadHiddenSenders(storage)
  if (canonical === null || current.includes(canonical)) return current
  const next = [...current, canonical]
  save(storage, next)
  return next
}

export function unhideSender(storage: StorageLike, address: string): readonly string[] {
  const canonical = canonicalAddress(address)
  const current = loadHiddenSenders(storage)
  if (canonical === null) return current
  const next = current.filter((entry) => entry !== canonical)
  if (next.length === current.length) return current
  save(storage, next)
  return next
}
