import { describe, expect, it } from 'vitest'

import { addEmail, getSettings, loadSession, NotifyError, putPreferences, saveSession, signIn, telegramLink } from './notify'
import type { StorageLike } from './identity'

const ADDRESS = 'NQ57 B9KP 90CE KELB BGNF TKLY C0QG 3LM3 EH2H'
const OTHER = 'NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK'

const memory = (): StorageLike => {
  const map = new Map<string, string>()
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value) }
}

type Call = { url: string; method: string; body: unknown; auth: string | null }

function fetchThat(answer: (call: Call) => { status: number; body: unknown }): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const call: Call = { url: String(url), method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), auth: headers['authorization'] ?? null }
    calls.push(call)
    const { status, body } = answer(call)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetchImpl, calls }
}

const sign = async () => ({ ok: true as const, publicKey: 'aa'.repeat(32), signature: 'bb'.repeat(64) })

describe('signIn', () => {
  it('asks for a challenge naming the address, signs it, and hands the signature back', async () => {
    const { fetchImpl, calls } = fetchThat((call) =>
      call.url.endsWith('/challenge') ? { status: 200, body: { nonce: 'n', text: 'sign me' } } : { status: 200, body: { token: 't0k', address: ADDRESS } },
    )
    const signed: string[] = []
    const outcome = await signIn('/notify', ADDRESS, async (address, text) => (signed.push(`${address}:${text}`), sign()), fetchImpl)
    expect(outcome).toEqual({ ok: true, token: 't0k', address: ADDRESS })
    expect(signed).toEqual([`${ADDRESS}:sign me`])
    expect(calls[0]).toMatchObject({ url: '/notify/challenge', method: 'POST', body: { address: ADDRESS } })
    expect(calls[1]).toMatchObject({ url: '/notify/session', body: { nonce: 'n', publicKey: 'aa'.repeat(32), signature: 'bb'.repeat(64) } })
  })

  it('reports a decline, a wallet that cannot sign, and a signature from another address', async () => {
    const { fetchImpl } = fetchThat((call) =>
      call.url.endsWith('/challenge') ? { status: 200, body: { nonce: 'n', text: 't' } } : { status: 409, body: { error: 'ADDRESS_MISMATCH', signer: OTHER } },
    )
    expect(await signIn('/notify', ADDRESS, null, fetchImpl)).toEqual({ ok: false, reason: 'unsupported' })
    expect(await signIn('/notify', ADDRESS, async () => ({ ok: false, reason: 'declined' }), fetchImpl)).toEqual({ ok: false, reason: 'declined' })
    expect(await signIn('/notify', ADDRESS, sign, fetchImpl)).toEqual({ ok: false, reason: 'mismatch', signer: OTHER })
  })

  it('reports an unreachable service as a failure with the detail', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    expect(await signIn('/notify', ADDRESS, sign, fetchImpl)).toMatchObject({ ok: false, reason: 'failed', detail: 'fetch failed' })
  })
})

describe('the settings calls', () => {
  it('carry the bearer, and read a gone session as signed out', async () => {
    const { fetchImpl, calls } = fetchThat((call) =>
      call.auth === 'Bearer t0k'
        ? { status: 200, body: { address: ADDRESS, preferences: { renewal: true, market: false, transfer: true, chat: true }, contacts: [{ id: 1, channel: 'email', target: 'k…e@x.io', confirmed: false }], channels: { email: true, telegram: false } } }
        : { status: 401, body: { error: 'NO_SESSION' } },
    )
    const settings = await getSettings('/notify', 't0k', fetchImpl)
    expect(settings?.preferences.market).toBe(false)
    expect(settings?.contacts).toEqual([{ id: 1, channel: 'email', target: 'k…e@x.io', confirmed: false }])
    expect(settings?.channels).toEqual({ email: true, telegram: false })
    expect(await getSettings('/notify', 'stale', fetchImpl)).toBeNull()
    await putPreferences('/notify', 't0k', { renewal: true, market: true, transfer: true, chat: false }, fetchImpl)
    expect(calls[2]).toMatchObject({ method: 'PUT', body: { preferences: { chat: false } } })
  })

  it('surface the service’s error code', async () => {
    const { fetchImpl } = fetchThat(() => ({ status: 400, body: { error: 'BAD_EMAIL', message: 'email must be a mailbox' } }))
    await expect(addEmail('/notify', 't0k', 'nope', fetchImpl)).rejects.toMatchObject({ code: 'BAD_EMAIL', status: 400 })
    await expect(telegramLink('/notify', 't0k', fetchImpl)).rejects.toBeInstanceOf(NotifyError)
  })
})

describe('sessions per device', () => {
  it('keep one token per address and forget on null', () => {
    const storage = memory()
    expect(loadSession(storage, ADDRESS)).toBeNull()
    saveSession(storage, ADDRESS, 'a')
    saveSession(storage, OTHER, 'b')
    expect(loadSession(storage, ADDRESS)).toBe('a')
    saveSession(storage, ADDRESS, null)
    expect(loadSession(storage, ADDRESS)).toBeNull()
    expect(loadSession(storage, OTHER)).toBe('b')
  })

  it('read a broken store as signed out', () => {
    const storage: StorageLike = { getItem: () => '{not json', setItem: () => undefined }
    expect(loadSession(storage, ADDRESS)).toBeNull()
  })
})
