/**
 * The notification service's client (`packages/notify`, tasks/26): sign in
 * with the address, then read and edit what it holds for that address.
 *
 * A session is a bearer token the service minted after verifying the
 * wallet's signature over a challenge it wrote. Kept per address in
 * `localStorage`, best-effort like every other per-device store here; an
 * expired or missing one is the signed-out state, never an error.
 */

import type { Category } from './notifyKinds'
import type { StorageLike } from './identity'
import type { SignOutcome } from './wallet'

export type { Category } from './notifyKinds'

export type Preferences = Record<Category, boolean>

export interface Contact {
  readonly id: number
  readonly channel: 'email' | 'telegram'
  /** Masked email, or null for a Telegram chat. */
  readonly target: string | null
  readonly confirmed: boolean
}

export interface NotifySettings {
  readonly address: string
  readonly preferences: Preferences
  readonly contacts: readonly Contact[]
  readonly channels: { readonly email: boolean; readonly telegram: boolean }
}

export class NotifyError extends Error {
  override readonly name = 'NotifyError'
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

type Fetch = typeof fetch

async function call(base: string, path: string, init: { method?: string; token?: string | null; body?: unknown }, fetchImpl: Fetch): Promise<unknown> {
  let response: Response
  try {
    response = await fetchImpl(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.token === undefined || init.token === null ? {} : { authorization: `Bearer ${init.token}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  } catch (error) {
    throw new NotifyError('UNREACHABLE', error instanceof Error ? error.message : String(error), 0)
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // A non-JSON body on an error status is still an answer.
  }
  if (!response.ok) {
    const record = (body ?? {}) as { error?: unknown; message?: unknown; signer?: unknown }
    const error = new NotifyError(
      typeof record.error === 'string' ? record.error : 'HTTP_ERROR',
      typeof record.message === 'string' ? record.message : `the service answered ${response.status}`,
      response.status,
    )
    if (typeof record.signer === 'string') (error as NotifyError & { signer?: string }).signer = record.signer
    throw error
  }
  return body
}

// ── Sessions, per device ────────────────────────────────────────────────────

const SESSIONS_KEY = 'nns.notify.sessions'

function readSessions(storage: StorageLike): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(SESSIONS_KEY) ?? '{}')
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Record<string, string> = {}
    for (const [address, token] of Object.entries(parsed as Record<string, unknown>)) if (typeof token === 'string') out[address] = token
    return out
  } catch {
    return {}
  }
}

export function loadSession(storage: StorageLike, address: string): string | null {
  return readSessions(storage)[address] ?? null
}

export function saveSession(storage: StorageLike, address: string, token: string | null): void {
  const sessions = readSessions(storage)
  if (token === null) delete sessions[address]
  else sessions[address] = token
  try {
    storage.setItem(SESSIONS_KEY, JSON.stringify(sessions))
  } catch {
    // Best-effort, like every per-device store here.
  }
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

export type SignInOutcome =
  | { readonly ok: true; readonly token: string; readonly address: string }
  | { readonly ok: false; readonly reason: 'declined' | 'unsupported' }
  | { readonly ok: false; readonly reason: 'mismatch'; readonly signer: string }
  | { readonly ok: false; readonly reason: 'failed'; readonly detail: string }

/**
 * Ask the service for a challenge naming `address`, have the wallet sign it,
 * hand the signature back. A wallet that signed with another of its
 * addresses is reported as `mismatch` with the signer, so the caller can
 * offer to sign in as that one instead.
 */
export async function signIn(
  base: string,
  address: string,
  sign: ((address: string, text: string) => Promise<SignOutcome>) | null,
  fetchImpl: Fetch = fetch,
): Promise<SignInOutcome> {
  if (sign === null) return { ok: false, reason: 'unsupported' }
  let challenge: { nonce: string; text: string }
  try {
    challenge = (await call(base, '/challenge', { method: 'POST', body: { address } }, fetchImpl)) as { nonce: string; text: string }
  } catch (error) {
    return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
  const signed = await sign(address, challenge.text)
  if (!signed.ok) return signed.reason === 'declined' ? { ok: false, reason: 'declined' } : { ok: false, reason: 'failed', detail: signed.detail ?? 'the wallet could not sign' }
  try {
    const session = (await call(
      base,
      '/session',
      { method: 'POST', body: { nonce: challenge.nonce, publicKey: signed.publicKey, signature: signed.signature } },
      fetchImpl,
    )) as { token: string; address: string }
    return { ok: true, token: session.token, address: session.address }
  } catch (error) {
    if (error instanceof NotifyError && error.code === 'ADDRESS_MISMATCH') {
      const signer = (error as NotifyError & { signer?: string }).signer
      if (signer !== undefined) return { ok: false, reason: 'mismatch', signer }
    }
    return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
}

// ── The settings, behind the session ────────────────────────────────────────

function asSettings(body: unknown): NotifySettings {
  const record = (body ?? {}) as Record<string, unknown>
  const prefs = (record['preferences'] ?? {}) as Record<string, unknown>
  const channels = (record['channels'] ?? {}) as Record<string, unknown>
  const contacts = Array.isArray(record['contacts']) ? record['contacts'] : []
  return {
    address: typeof record['address'] === 'string' ? record['address'] : '',
    preferences: {
      renewal: prefs['renewal'] !== false,
      market: prefs['market'] !== false,
      transfer: prefs['transfer'] !== false,
      chat: prefs['chat'] !== false,
    },
    contacts: contacts.flatMap((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>
      if (typeof row['id'] !== 'number' || (row['channel'] !== 'email' && row['channel'] !== 'telegram')) return []
      return [{ id: row['id'], channel: row['channel'], target: typeof row['target'] === 'string' ? row['target'] : null, confirmed: row['confirmed'] === true }]
    }),
    channels: { email: channels['email'] === true, telegram: channels['telegram'] === true },
  }
}

/** The address's settings, or `null` when the session is gone (signed out). */
export async function getSettings(base: string, token: string, fetchImpl: Fetch = fetch): Promise<NotifySettings | null> {
  try {
    return asSettings(await call(base, '/settings', { token }, fetchImpl))
  } catch (error) {
    if (error instanceof NotifyError && error.status === 401) return null
    throw error
  }
}

export async function putPreferences(base: string, token: string, preferences: Preferences, fetchImpl: Fetch = fetch): Promise<NotifySettings> {
  return asSettings(await call(base, '/settings', { method: 'PUT', token, body: { preferences } }, fetchImpl))
}

export async function addEmail(base: string, token: string, email: string, fetchImpl: Fetch = fetch): Promise<Contact> {
  const body = (await call(base, '/contacts/email', { method: 'POST', token, body: { email } }, fetchImpl)) as { contact: Contact }
  return body.contact
}

export async function telegramLink(base: string, token: string, fetchImpl: Fetch = fetch): Promise<string> {
  const body = (await call(base, '/contacts/telegram', { method: 'POST', token }, fetchImpl)) as { link: string }
  return body.link
}

export async function removeContact(base: string, token: string, id: number, fetchImpl: Fetch = fetch): Promise<NotifySettings> {
  return asSettings(await call(base, `/contacts/${id}`, { method: 'DELETE', token }, fetchImpl))
}

export async function deleteEverything(base: string, token: string, fetchImpl: Fetch = fetch): Promise<void> {
  await call(base, '/delete', { method: 'POST', token }, fetchImpl)
}

export async function signOut(base: string, token: string, fetchImpl: Fetch = fetch): Promise<void> {
  await call(base, '/logout', { method: 'POST', token }, fetchImpl).catch(() => undefined)
}
