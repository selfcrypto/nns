/**
 * The HTTP contract the app depends on, against the in-memory store: the
 * sign-in round trip with a real signature, the settings the sheet reads,
 * the email round trip through the confirmation link, and the deep link.
 */

import type { AddressInfo } from 'node:net'

import { keypairFromPrivateKey, signMessage } from '@nimiqnames/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FakeStore, asStore } from './test-support/fake-store.js'
import { createLogger } from './logger.js'
import { createNotifyServer, maskEmail } from './server.js'
import { canonicalAddress } from './session.js'
import type { EmailMessage } from './transport.js'

const KEY = keypairFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000001')
const OTHER = keypairFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000002')
const address = canonicalAddress(KEY.address)!

describe('the notify server', () => {
  const store = new FakeStore()
  const mails: EmailMessage[] = []
  const server = createNotifyServer({
    store: asStore(store),
    logger: createLogger('error', () => undefined),
    host: 'nimiqnames.com',
    publicUrl: 'https://nimiqnames.com/notify',
    appUrl: 'https://nimiqnames.com',
    conventions: ['nimiq'],
    sessionTtlMs: 3_600_000,
    telegramBot: 'nimiqnamesbot',
    email: { send: async (message) => void mails.push(message) },
  })
  let base = ''
  let token = ''

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const post = (path: string, body: unknown, bearer?: string) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }) },
      body: JSON.stringify(body),
    })
  const json = async <T,>(response: Response): Promise<T> => (await response.json()) as T

  it('signs an address in: challenge, signature, session', async () => {
    const challenge = await json<{ nonce: string; text: string }>(await post('/challenge', { address: KEY.address }))
    expect(challenge.text).toContain(`NNS notifications for ${address} on nimiqnames.com`)

    const wrongKey = await post('/session', { nonce: challenge.nonce, publicKey: OTHER.publicKey, signature: signMessage(OTHER.privateKey, challenge.text) })
    expect(wrongKey.status).toBe(409)
    expect((await json<{ signer: string }>(wrongKey)).signer).toBe(canonicalAddress(OTHER.address))
    // A challenge is taken once: the mismatch consumed it.
    expect((await post('/session', { nonce: challenge.nonce, publicKey: KEY.publicKey, signature: signMessage(KEY.privateKey, challenge.text) })).status).toBe(410)

    const fresh = await json<{ nonce: string; text: string }>(await post('/challenge', { address }))
    const session = await post('/session', { nonce: fresh.nonce, publicKey: KEY.publicKey, signature: signMessage(KEY.privateKey, fresh.text) })
    expect(session.status).toBe(200)
    const body = await json<{ token: string; address: string }>(session)
    expect(body.address).toBe(address)
    token = body.token
  })

  it('refuses a bad address and a bad signature', async () => {
    expect((await post('/challenge', { address: 'nope' })).status).toBe(400)
    const fresh = await json<{ nonce: string; text: string }>(await post('/challenge', { address }))
    expect((await post('/session', { nonce: fresh.nonce, publicKey: KEY.publicKey, signature: 'ff' })).status).toBe(401)
  })

  it('answers the settings for the session, and nothing without one', async () => {
    expect((await fetch(`${base}/settings`)).status).toBe(401)
    const settings = await json<{ address: string; preferences: Record<string, boolean>; contacts: unknown[]; channels: { email: boolean; telegram: boolean } }>(
      await fetch(`${base}/settings`, { headers: { authorization: `Bearer ${token}` } }),
    )
    expect(settings).toEqual({ address, preferences: { renewal: true, market: true, transfer: true, chat: true }, contacts: [], channels: { email: true, telegram: true } })
  })

  it('updates the preferences', async () => {
    const response = await fetch(`${base}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ preferences: { renewal: true, market: false, transfer: true, chat: false } }),
    })
    expect((await json<{ preferences: Record<string, boolean> }>(response)).preferences).toEqual({ renewal: true, market: false, transfer: true, chat: false })
    const bad = await fetch(`${base}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ preferences: { renewal: 'yes' } }),
    })
    expect(bad.status).toBe(400)
  })

  it('adds an email, mails the confirmation, confirms through the link, and unsubscribes through the other', async () => {
    const added = await post('/contacts/email', { email: 'Kike@Example.com' }, token)
    expect(added.status).toBe(202)
    expect((await json<{ contact: { target: string; confirmed: boolean } }>(added)).contact).toEqual({ id: 1, channel: 'email', target: 'k…e@example.com', confirmed: false })
    expect(mails).toHaveLength(1)
    expect(mails[0]?.to).toBe('kike@example.com')
    const link = /https:\/\/nimiqnames\.com\/notify\/confirm\/([A-Za-z0-9_-]+)/.exec(mails[0]?.text ?? '')?.[1]
    expect(link).toBeDefined()

    const confirmed = await fetch(`${base}/confirm/${link}`)
    expect(confirmed.status).toBe(200)
    expect(await confirmed.text()).toContain('Email confirmed')
    expect((await fetch(`${base}/confirm/${link}`)).status).toBe(410)

    const settings = await json<{ contacts: { confirmed: boolean }[] }>(await fetch(`${base}/settings`, { headers: { authorization: `Bearer ${token}` } }))
    expect(settings.contacts[0]?.confirmed).toBe(true)

    const unsubscribe = store.rows[0]?.unsubscribeToken ?? ''
    expect(await (await post(`/unsubscribe/${unsubscribe}`, {})).text()).toContain('Unsubscribed')
    expect(store.rows).toHaveLength(0)
    expect(await (await fetch(`${base}/unsubscribe/${unsubscribe}`)).text()).toContain('Already unsubscribed')
    expect((await post('/contacts/email', { email: 'not a mailbox' }, token)).status).toBe(400)
  })

  it('mints a Telegram deep link the bot can redeem', async () => {
    const { link } = await json<{ link: string }>(await post('/contacts/telegram', {}, token))
    expect(link).toMatch(/^https:\/\/t\.me\/nimiqnamesbot\?start=[A-Za-z0-9_-]+$/)
    expect(store.links.size).toBe(1)
  })

  it('deletes a contact, logs out, and deletes everything', async () => {
    store.seed(address, 'telegram', '42')
    const id = store.rows[0]?.id
    const removed = await fetch(`${base}/contacts/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
    expect(removed.status).toBe(200)
    expect((await fetch(`${base}/contacts/999`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status).toBe(404)

    store.seed(address, 'email', 'kike@example.com')
    expect((await post('/delete', {}, token)).status).toBe(200)
    expect(store.rows).toHaveLength(0)
    expect((await fetch(`${base}/settings`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401)
  })

  it('answers health and CORS preflight, and 404 elsewhere', async () => {
    expect((await json<{ ok: boolean }>(await fetch(`${base}/healthz`))).ok).toBe(true)
    const preflight = await fetch(`${base}/settings`, { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect((await fetch(`${base}/nope`)).status).toBe(404)
  })
})

describe('maskEmail', () => {
  it('keeps the first and last letter and the domain', () => {
    expect(maskEmail('kike@example.com')).toBe('k…e@example.com')
    expect(maskEmail('ab@x.io')).toBe('ab@x.io')
    expect(maskEmail('a@x.io')).toBe('a@x.io')
  })
})
