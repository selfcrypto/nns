/**
 * §8.5 first-use pinning — the strongest per-user defence there is, because
 * it needs no external party: pin `query → address` the first time an answer
 * is shown on this device, and hard-stop when a known mapping changes.
 * States and wording: docs/app-states.md §2.
 *
 * Keys are the full query string: a plain name pins its resolution target,
 * a dotted query pins the delegated answer — both are addresses a user
 * might pay, and a changed deposit address deserves the same stop.
 *
 * Per-device and best-effort by design (WebView storage is evictable). The
 * one failure that must not happen: a broken store reading as "first use",
 * which would silently unpin — store errors surface as `unchecked`, never
 * as a fresh pin.
 */

import { sameAddress } from './states'

export interface PinRecord {
  readonly query: string
  readonly address: string
  readonly pinnedAt: number
}

export interface PinStore {
  get(query: string): Promise<PinRecord | null>
  put(record: PinRecord): Promise<void>
}

export type PinVerdict =
  | { readonly kind: 'first-use' }
  | { readonly kind: 'match' }
  | { readonly kind: 'mismatch'; readonly pinned: PinRecord }
  /** The store failed. Not a fresh pin, not a match — the check did not run. */
  | { readonly kind: 'unchecked' }

export async function checkAndPin(store: PinStore, query: string, address: string, nowMs: number): Promise<PinVerdict> {
  let existing: PinRecord | null
  try {
    existing = await store.get(query)
  } catch {
    return { kind: 'unchecked' }
  }
  if (existing === null) {
    try {
      await store.put({ query, address, pinnedAt: nowMs })
    } catch {
      // The pin did not stick; the answer is still shown. Next use is
      // another first use — worse than remembering, better than blocking.
    }
    return { kind: 'first-use' }
  }
  if (sameAddress(existing.address, address)) return { kind: 'match' }
  return { kind: 'mismatch', pinned: existing }
}

/** The explicit, effortful override of docs/app-states.md §2 — never called implicitly. */
export async function overridePin(store: PinStore, query: string, address: string, nowMs: number): Promise<void> {
  await store.put({ query, address, pinnedAt: nowMs })
}

// ── Stores ──────────────────────────────────────────────────────────────────

export function memoryPinStore(): PinStore {
  const pins = new Map<string, PinRecord>()
  return {
    get: (query) => Promise.resolve(pins.get(query) ?? null),
    put: (record) => {
      pins.set(record.query, record)
      return Promise.resolve()
    },
  }
}

const DB_NAME = 'nns-app'
const STORE_NAME = 'pins'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'query' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'))
  })
}

export function idbPinStore(): PinStore {
  let database: Promise<IDBDatabase> | null = null
  const open = (): Promise<IDBDatabase> => (database ??= openDatabase())

  return {
    async get(query) {
      const db = await open()
      return new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(query)
        request.onsuccess = () => {
          const value = request.result as PinRecord | undefined
          resolve(value ?? null)
        }
        request.onerror = () => reject(request.error ?? new Error('pin read failed'))
      })
    },
    async put(record) {
      const db = await open()
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite')
        transaction.objectStore(STORE_NAME).put(record)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error ?? new Error('pin write failed'))
      })
    },
  }
}

let defaultStore: PinStore | null = null

/**
 * IndexedDB where it exists (it survives WebView restarts better than
 * localStorage), an in-memory session store where it does not — degraded,
 * never absent.
 */
export function pinStore(): PinStore {
  if (defaultStore === null) {
    defaultStore = typeof indexedDB === 'undefined' ? memoryPinStore() : idbPinStore()
  }
  return defaultStore
}
