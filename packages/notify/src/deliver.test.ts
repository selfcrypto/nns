import { describe, expect, it } from 'vitest'

import { deliver, type DeliverOptions } from './deliver.js'
import type { NotifyEvent } from './events.js'
import { FakeStore, asStore } from './test-support/fake-store.js'
import { createLogger } from './logger.js'
import { DeliveryRefused, type EmailMessage } from './transport.js'

const ALICE = 'NQ57 B9KP 90CE KELB BGNF TKLY C0QG 3LM3 EH2H'
const silent = createLogger('error', () => undefined)

const options = (store: FakeStore, mails: EmailMessage[], chats: string[], refuse = false): DeliverOptions => ({
  store: asStore(store),
  transport: {
    email: {
      send: async (message) => {
        if (refuse) throw new DeliveryRefused('550 no such user')
        mails.push(message)
      },
    },
    telegram: { send: async (chatId, text) => void chats.push(`${chatId}: ${text}`) },
  },
  logger: silent,
  context: { head: 62_400_000, nowMs: Date.parse('2026-09-23T12:00:00Z'), appUrl: 'https://nimiqnames.com', nameOf: () => null },
  unsubscribeUrl: (contact) => `https://nimiqnames.com/notify/unsubscribe/${contact.unsubscribeToken}`,
  maxFailures: 2,
})

const event: NotifyEvent = { kind: 'renewal_open', to: ALICE, name: 'riconame', expiry: 62_500_000 }

describe('deliver', () => {
  it('sends to every confirmed contact whose category is on, once', async () => {
    const store = new FakeStore()
    store.seed(ALICE, 'email', 'kike@example.com')
    store.seed(ALICE, 'telegram', '42')
    const mails: EmailMessage[] = []
    const chats: string[] = []
    expect(await deliver([event], options(store, mails, chats))).toEqual({ sent: 2, skipped: 0, failed: 0 })
    expect(mails[0]?.subject).toBe('riconame can be renewed')
    expect(mails[0]?.unsubscribeUrl).toContain('/unsubscribe/')
    expect(chats[0]).toContain('42: riconame can be renewed')
    // The same event on the next poll goes nowhere.
    expect(await deliver([event], options(store, mails, chats))).toEqual({ sent: 0, skipped: 2, failed: 0 })
    expect(mails).toHaveLength(1)
  })

  it('respects the category toggles and an unconfirmed contact', async () => {
    const store = new FakeStore()
    store.seed(ALICE, 'email', 'kike@example.com', ['market'])
    const mails: EmailMessage[] = []
    expect((await deliver([event], options(store, mails, []))).sent).toBe(0)
    const sale: NotifyEvent = { kind: 'offer_bought', to: ALICE, name: 'riconame', buyer: 'NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK', price: 62_500_000n }
    expect((await deliver([sale], options(store, mails, []))).sent).toBe(1)
    expect(mails[0]?.text).toContain('625 NIM')
  })

  it('drops a contact after repeated refusals and leaves transient failures for the next poll', async () => {
    const store = new FakeStore()
    store.seed(ALICE, 'email', 'gone@example.com')
    expect((await deliver([event], options(store, [], [], true))).failed).toBe(1)
    expect(store.rows).toHaveLength(1)
    expect((await deliver([{ ...event, name: 'other' }], options(store, [], [], true))).failed).toBe(1)
    expect(store.rows).toHaveLength(0)
  })
})
