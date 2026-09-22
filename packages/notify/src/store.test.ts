/**
 * Store integration — **needs a real Postgres**, and is skipped without one.
 *
 *   NNS_TEST_DATABASE_URL=postgres://…/throwaway pnpm vitest run --project notify
 *
 * Its own named schema, like the other gated suites, so they share one
 * throwaway database without deleting each other's tables.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Store, createPool, migrate } from './store.js'

const DB = process.env['NNS_TEST_DATABASE_URL']
const SCHEMA = 'notify_test'
const POOL_URL = DB === undefined ? '' : `${DB}${DB.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`

const ALICE = 'NQ57 B9KP 90CE KELB BGNF TKLY C0QG 3LM3 EH2H'
const BOB = 'NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK'
const NOW = new Date('2026-09-23T12:00:00Z')
const LATER = new Date('2026-09-23T13:00:00Z')
const MUCH_LATER = new Date('2026-12-23T13:00:00Z')

describe.skipIf(DB === undefined)('Store', () => {
  const pool = createPool(POOL_URL)
  const store = new Store(pool)

  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.query(`CREATE SCHEMA ${SCHEMA}`)
    await migrate(pool)
  })
  afterAll(async () => {
    await pool.end()
  })

  it('hands a challenge out once, and not after it expired', async () => {
    await store.createChallenge('n1', ALICE, 'text', LATER)
    expect(await store.takeChallenge('n1', NOW)).toEqual({ address: ALICE, text: 'text' })
    expect(await store.takeChallenge('n1', NOW)).toBeNull()
    await store.createChallenge('n2', ALICE, 'text', NOW)
    expect(await store.takeChallenge('n2', LATER)).toBeNull()
  })

  it('answers a session until it expires', async () => {
    await store.createSession('h1', ALICE, LATER)
    expect(await store.sessionAddress('h1', NOW)).toBe(ALICE)
    expect(await store.sessionAddress('h1', MUCH_LATER)).toBeNull()
    await store.deleteSession('h1')
    expect(await store.sessionAddress('h1', NOW)).toBeNull()
  })

  it('defaults preferences to everything on and keeps what is set', async () => {
    expect(await store.preferences(ALICE)).toEqual({ renewal: true, market: true, transfer: true, chat: true })
    await store.setPreferences(ALICE, { renewal: true, market: false, transfer: true, chat: false })
    expect(await store.preferences(ALICE)).toEqual({ renewal: true, market: false, transfer: true, chat: false })
  })

  it('takes an email through confirmation and out again through unsubscribe', async () => {
    const contact = await store.addEmail(ALICE, 'kike@example.com', 'c1', LATER, 'u1')
    expect(contact.confirmed).toBe(false)
    expect(await store.subscribedAddresses()).toEqual(new Set())
    // Re-adding before confirmation re-issues the token.
    await store.addEmail(ALICE, 'kike@example.com', 'c2', LATER, 'u-ignored')
    expect(await store.confirmEmail('c1', NOW)).toBeNull()
    const confirmed = await store.confirmEmail('c2', NOW)
    expect(confirmed?.confirmed).toBe(true)
    expect(confirmed?.unsubscribeToken).toBe('u1')
    expect(await store.subscribedAddresses()).toEqual(new Set([ALICE]))
    expect((await store.confirmedContacts(ALICE)).map((c) => c.target)).toEqual(['kike@example.com'])
    // Re-adding a confirmed one changes nothing.
    expect((await store.addEmail(ALICE, 'kike@example.com', 'c3', LATER, 'u2')).confirmed).toBe(true)
    expect(await store.confirmEmail('c3', NOW)).toBeNull()
    expect((await store.unsubscribe('u1'))?.address).toBe(ALICE)
    expect(await store.contacts(ALICE)).toEqual([])
  })

  it('binds a Telegram chat through a deep link, once, and unlinks by chat', async () => {
    await store.createTelegramLink('t1', BOB, LATER)
    expect(await store.bindTelegram('t1', '42', 'u3', NOW)).toBe(BOB)
    expect(await store.bindTelegram('t1', '42', 'u4', NOW)).toBeNull()
    await store.createTelegramLink('t2', BOB, NOW)
    expect(await store.bindTelegram('t2', '42', 'u5', LATER)).toBeNull()
    expect(await store.addressesOfChat('42')).toEqual([BOB])
    expect((await store.confirmedContacts(BOB))[0]?.confirmed).toBe(true)
    expect(await store.unlinkTelegram('42')).toBe(1)
    expect(await store.unlinkTelegram('42')).toBe(0)
  })

  it('records a send once and counts refusals up to the drop', async () => {
    const contact = await store.addEmail(ALICE, 'again@example.com', 'c9', LATER, 'u9')
    expect(await store.wasSent(ALICE, 'k', contact.id)).toBe(false)
    await store.markSent(ALICE, 'k', contact.id)
    await store.markSent(ALICE, 'k', contact.id)
    expect(await store.wasSent(ALICE, 'k', contact.id)).toBe(true)
    expect(await store.recordFailure(contact.id, 2)).toBe(1)
    expect((await store.contacts(ALICE)).find((c) => c.id === contact.id)?.failures).toBe(1)
    await store.clearFailures(contact.id)
    expect(await store.recordFailure(contact.id, 2)).toBe(1)
    expect(await store.recordFailure(contact.id, 2)).toBe(2)
    expect((await store.contacts(ALICE)).find((c) => c.id === contact.id)).toBeUndefined()
  })

  it('deletes everything about an address', async () => {
    await store.addEmail(ALICE, 'x@example.com', 'cx', LATER, 'ux')
    await store.createSession('hx', ALICE, LATER)
    await store.deleteAddress(ALICE)
    expect(await store.contacts(ALICE)).toEqual([])
    expect(await store.sessionAddress('hx', NOW)).toBeNull()
    expect(await store.preferences(ALICE)).toEqual({ renewal: true, market: true, transfer: true, chat: true })
  })

  it('keeps the cursor and sweeps what expired', async () => {
    expect(await store.loadCursor()).toBeNull()
    await store.saveCursor({ checkpointHeight: 62_400_000, chatHeight: null, networkId: 24 })
    await store.saveCursor({ checkpointHeight: 62_400_720, chatHeight: 62_400_100, networkId: 24 })
    expect(await store.loadCursor()).toEqual({ checkpointHeight: 62_400_720, chatHeight: 62_400_100, networkId: 24 })
    await store.addEmail(BOB, 'stale@example.com', 'cs', NOW, 'us')
    await store.sweep(LATER)
    expect(await store.contacts(BOB)).toEqual([])
  })
})
