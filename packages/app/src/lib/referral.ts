/**
 * The referral link's client half (§10.7, `tasks/18`).
 *
 * `nimiqnames.com/?ref=<name>` — or `#/buy?ref=<name>` — names the owner who
 * brought this person here. The app remembers it until a registration is
 * confirmed, then sends it as the `G`'s `ref` (§6 `G`), where the treasury's
 * settlement pays the referring name's target a share of the fee.
 *
 * Three rules, all from the field being inert by protocol:
 *
 * - **A bad ref is dropped silently, never an error.** It is a registered
 *   name or it is nothing; the app checks the syntax here and the chain
 *   decides the rest at the `G`'s height.
 * - **First wins.** A later generic share must not overwrite the person who
 *   actually brought the user, and the link is rarely followed and acted on
 *   in one sitting — the store is durable for the same reason `pinning.ts`'s
 *   is, and it is cleared only when a registration confirms.
 * - **Nothing else carries it.** Renewals, buys and bids have no `ref`
 *   (spec); only the `G` does.
 */

import { isValidRef, validateNameSyntax } from '@nns/core'

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

/** The link an owner shares: the app's own origin, `?ref=<name>`, nothing else — domain-agnostic. */
export function shareLinkFor(name: string, base: string = globalThis.document?.baseURI ?? ''): string {
  try {
    const origin = new URL(base).origin
    return `${origin}/?${PARAM}=${encodeURIComponent(name)}`
  } catch {
    return `/?${PARAM}=${encodeURIComponent(name)}`
  }
}

// ── Store ───────────────────────────────────────────────────────────────────

export interface ReferralStore {
  get(): Promise<string | null>
  /** First wins: a stored ref is kept, a new one is stored only into an empty slot. */
  remember(ref: string): Promise<void>
  clear(): Promise<void>
}

export function memoryReferralStore(): ReferralStore {
  let stored: string | null = null
  return {
    get: () => Promise.resolve(stored),
    remember: (ref) => {
      stored ??= ref
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
      request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null)
      request.onerror = () => reject(request.error ?? new Error('referral read failed'))
    })
  }
  const write = async (value: string | null): Promise<void> => {
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
      if ((await read()) !== null) return
      await write(ref)
    },
    clear: () => write(null),
  }
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
export const rememberReferral = (ref: string): Promise<void> => referralStore().remember(ref).catch(() => undefined)
export const clearReferral = (): Promise<void> => referralStore().clear().catch(() => undefined)
