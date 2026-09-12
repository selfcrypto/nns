/**
 * The referral link's client half (§10.7, `tasks/18`).
 *
 * `nimiqnames.com/?ref=<name>` — or `#/buy?ref=<name>` — names the owner who
 * brought this person here. The app remembers it until a registration is
 * confirmed, then sends it as the `G`'s `ref` (§6 `G`), where the treasury's
 * settlement pays the referring name's target a share of the fee.
 *
 * Four rules, all from the field being inert by protocol:
 *
 * - **A bad ref is dropped silently, never an error.** It is a registered
 *   name or it is nothing; the app checks the syntax here and the chain
 *   decides the rest at the `G`'s height.
 * - **First wins.** A later generic share must not overwrite the person who
 *   actually brought the user, and the link is rarely followed and acted on
 *   in one sitting — the store is durable for the same reason `pinning.ts`'s
 *   is, and it is cleared when a registration confirms.
 * - **It also expires.** §10.7's referral is earned when the link is used
 *   (Kike, 2026-09-12), and a slot with no clock turns "used a link" into
 *   "used a link at some point in the past", which is a different claim. So
 *   the entry carries the moment it was stored and dies `REFERRAL_TTL_MS`
 *   later. Days rather than minutes: a link is read on a phone and acted on
 *   the next day, and that is still the link doing the work.
 * - **Nothing else carries it.** Renewals, buys and bids have no `ref`
 *   (spec); only the `G` does.
 *
 * A link arrives two ways and means the same thing both times: in the address
 * bar (`referralFromLocation`), or **pasted into the search box**
 * (`referralFromLink`), which is the only route a reader already inside Nimiq
 * Pay has — the mini app opens at a bare URL from Pay's own list, there is no
 * address bar in it, and a link tapped in a chat app opens a browser instead.
 * `payRequest.ts` does the same for a payment link, for the same reason.
 */

import { isValidRef, validateNameSyntax } from '@nns/core'
import { sameAddress } from './states'

const PARAM = 'ref'

/** A ref is a registered name: the name's syntax, and the field's own alphabet. */
export function isReferralName(value: string): boolean {
  return validateNameSyntax(value).ok === true && isValidRef(value)
}

/**
 * The ref a page load carries, or `null`. The search string is read first
 * (the shape a share link has), then a query on the hash (`#/buy?ref=x`,
 * which the router tolerates). Anything unparseable or invalid is `null`.
 */
export function referralFromLocation(search: string, hash: string): string | null {
  for (const query of [search, hash.includes('?') ? hash.slice(hash.indexOf('?')) : '']) {
    if (query === '' || query === '?') continue
    let value: string | null
    try {
      value = new URLSearchParams(query).get(PARAM)
    } catch {
      continue
    }
    if (value === null) continue
    const trimmed = value.trim().toLowerCase()
    if (isReferralName(trimmed)) return trimmed
  }
  return null
}

/**
 * The ref inside a **pasted** share link, or `null`.
 *
 * Anything that is not a link with a usable `ref` is `null`, including a
 * plain name: the search box hands it everything typed, and a name must go on
 * being a search. A missing scheme is tolerated because a link that has been
 * through a chat app often arrives without one.
 */
export function referralFromLink(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed === '' || !trimmed.includes('?')) return null
  for (const candidate of [trimmed, `https://${trimmed}`]) {
    let url: URL
    try {
      url = new URL(candidate)
    } catch {
      continue
    }
    const found = referralFromLocation(url.search, url.hash)
    if (found !== null) return found
  }
  return null
}

/** The link an owner shares: the app's own origin, `?ref=<name>`, nothing else — domain-agnostic. */
export function shareLinkFor(name: string, base: string = globalThis.document?.baseURI ?? ''): string {
  try {
    const origin = new URL(base).origin
    return `${origin}/?${PARAM}=${encodeURIComponent(name)}`
  } catch {
    return `/?${PARAM}=${encodeURIComponent(name)}`
  }
}

/**
 * Whether the stored ref names a name **this viewer already controls** —
 * settlement's `selfReferred` (`share.ts`), decided client-side so the link is
 * dropped before it ever reaches the chain.
 *
 * A referral pays for bringing somebody new. When the buyer already holds the
 * referring name, the treasury would be moving money from the payer back to
 * the payer, and the published table prices that at `selfBp` — zero by
 * default. So the honest thing on this side is to drop the ref and say so,
 * rather than send a `G` whose review line promised a share nobody will pay.
 *
 * **Owner or target**, because both are the buyer in the cases that matter: a
 * name whose owner is another of the viewer's addresses is still theirs, and
 * `M` pays the `target`, so a ref pointed at the viewer's own receiving
 * address is the same round trip.
 *
 * Best-effort by construction — the record is fetched over the network and a
 * miss reads as "not self", exactly as settlement's own check does when it
 * cannot tell. The chain is not being asked to enforce anything here.
 */
export function isSelfReferral(
  record: { readonly owner: string; readonly target: string } | null,
  viewers: readonly string[],
): boolean {
  if (record === null) return false
  return viewers.some((viewer) => sameAddress(record.owner, viewer) || sameAddress(record.target, viewer))
}

// ── Store ───────────────────────────────────────────────────────────────────

/** Seven days. Long enough to read a link and act on it another day, short enough that it is still that link. */
export const REFERRAL_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** What the slot holds: the ref, and when it was put there. */
interface StoredReferral {
  readonly ref: string
  readonly at: number
}

/**
 * A stored value that is still a referral, or `null`.
 *
 * A bare string is what the store held before the field existed. It reads as
 * expired rather than as fresh: its age is exactly the thing that was not
 * recorded, and the alternative is granting an unknown number of forgotten
 * slots another seven days from the moment this ships.
 */
function live(value: unknown, now: number): string | null {
  if (typeof value !== 'object' || value === null) return null
  const { ref, at } = value as Partial<StoredReferral>
  if (typeof ref !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) return null
  if (!isReferralName(ref)) return null
  // A clock that has moved backwards (a device correcting its time) reads as
  // fresh, not as expired — the user did nothing wrong.
  if (now - at >= REFERRAL_TTL_MS) return null
  return ref
}

export interface ReferralStore {
  get(): Promise<string | null>
  /** First wins: a live ref is kept, a new one is stored only into an empty or expired slot. */
  remember(ref: string): Promise<void>
  clear(): Promise<void>
}

export function memoryReferralStore(): ReferralStore {
  let stored: StoredReferral | null = null
  return {
    get: () => Promise.resolve(live(stored, Date.now())),
    remember: (ref) => {
      if (live(stored, Date.now()) === null) stored = { ref, at: Date.now() }
      return Promise.resolve()
    },
    clear: () => {
      stored = null
      return Promise.resolve()
    },
  }
}

const DB_NAME = 'nns-app-referral'
const STORE_NAME = 'referral'
const KEY = 'current'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'))
  })
}

export function idbReferralStore(): ReferralStore {
  let database: Promise<IDBDatabase> | null = null
  const open = (): Promise<IDBDatabase> => (database ??= openDatabase())

  const read = async (): Promise<string | null> => {
    const db = await open()
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(KEY)
      request.onsuccess = () => resolve(live(request.result, Date.now()))
      request.onerror = () => reject(request.error ?? new Error('referral read failed'))
    })
  }
  const write = async (value: StoredReferral | null): Promise<void> => {
    const db = await open()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      if (value === null) store.delete(KEY)
      else store.put(value, KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('referral write failed'))
    })
  }

  return {
    get: read,
    async remember(ref) {
      // An expired slot is an empty slot: the read is the expiry check, so an
      // old ref does not lock out the link the user has just followed.
      if ((await read()) !== null) return
      await write({ ref, at: Date.now() })
    },
    clear: () => write(null),
  }
}

// ── Change notification ─────────────────────────────────────────────────────

/**
 * The strip has to follow the slot, and the slot is written from three places
 * — the page load, a link pasted into a search box, and the remove control.
 * Nothing here polls: a write announces itself, which is the whole mechanism.
 */
const listeners = new Set<() => void>()

/** Subscribe to writes; returns the unsubscribe. */
export function onReferralChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const announce = (): void => {
  for (const listener of [...listeners]) listener()
}

let defaultStore: ReferralStore | null = null

/** IndexedDB where it exists, memory where it does not — degraded, never absent (as `pinStore`). */
export function referralStore(): ReferralStore {
  if (defaultStore === null) defaultStore = typeof indexedDB === 'undefined' ? memoryReferralStore() : idbReferralStore()
  return defaultStore
}

/**
 * Best effort, every call: a referral must never break a screen. A store
 * that throws (private mode, a WebView without IndexedDB) reads as "no ref".
 */
export const storedReferral = (): Promise<string | null> => referralStore().get().catch(() => null)
export const rememberReferral = (ref: string): Promise<void> =>
  referralStore()
    .remember(ref)
    .catch(() => undefined)
    .then(announce)
export const clearReferral = (): Promise<void> =>
  referralStore()
    .clear()
    .catch(() => undefined)
    .then(announce)
