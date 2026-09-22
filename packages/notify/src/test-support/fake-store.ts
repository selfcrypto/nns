/**
 * An in-memory `Store` for the tests that need one and not a database: the
 * HTTP surface and delivery. It mirrors the methods, not the SQL;
 * `store.test.ts` covers the real one.
 */

import type { Category } from '../events.js'
import { ALL_ON, type Contact, type Cursor, type Preferences, type Store } from '../store.js'

interface Row extends Omit<Contact, 'failures' | 'confirmed'> {
  confirmed: boolean
  failures: number
  confirmHash: string | null
  confirmExpires: Date | null
}

export class FakeStore implements Pick<Store, keyof Store> {
  challenges = new Map<string, { address: string; text: string; expiresAt: Date }>()
  sessions = new Map<string, { address: string; expiresAt: Date }>()
  rows: Row[] = []
  links = new Map<string, { address: string; expiresAt: Date }>()
  prefs = new Map<string, Preferences>()
  sent = new Set<string>()
  cursor: Cursor | null = null
  private nextId = 1

  async createChallenge(nonce: string, address: string, text: string, expiresAt: Date): Promise<void> {
    this.challenges.set(nonce, { address, text, expiresAt })
  }
  async takeChallenge(nonce: string, now: Date): Promise<{ address: string; text: string } | null> {
    const row = this.challenges.get(nonce)
    this.challenges.delete(nonce)
    return row === undefined || row.expiresAt < now ? null : { address: row.address, text: row.text }
  }
  async createSession(tokenHash: string, address: string, expiresAt: Date): Promise<void> {
    this.sessions.set(tokenHash, { address, expiresAt })
  }
  async sessionAddress(tokenHash: string, now: Date): Promise<string | null> {
    const row = this.sessions.get(tokenHash)
    return row === undefined || row.expiresAt <= now ? null : row.address
  }
  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash)
  }
  async preferences(address: string): Promise<Preferences> {
    return this.prefs.get(address) ?? ALL_ON
  }
  async setPreferences(address: string, prefs: Preferences): Promise<void> {
    this.prefs.set(address, prefs)
  }
  async contacts(address: string): Promise<readonly Contact[]> {
    return this.rows.filter((row) => row.address === address)
  }
  async addEmail(address: string, email: string, confirmHash: string, confirmExpires: Date, unsubscribeToken: string): Promise<Contact> {
    const existing = this.rows.find((row) => row.address === address && row.channel === 'email' && row.target === email)
    if (existing !== undefined) {
      if (!existing.confirmed) Object.assign(existing, { confirmHash, confirmExpires })
      return existing
    }
    const row: Row = { id: this.nextId++, address, channel: 'email', target: email, confirmed: false, failures: 0, unsubscribeToken, confirmHash, confirmExpires }
    this.rows.push(row)
    return row
  }
  async confirmEmail(confirmHash: string, now: Date): Promise<Contact | null> {
    const row = this.rows.find((r) => r.confirmHash === confirmHash && !r.confirmed && r.confirmExpires !== null && r.confirmExpires > now)
    if (row === undefined) return null
    Object.assign(row, { confirmed: true, confirmHash: null, confirmExpires: null })
    return row
  }
  async createTelegramLink(tokenHash: string, address: string, expiresAt: Date): Promise<void> {
    this.links.set(tokenHash, { address, expiresAt })
  }
  async bindTelegram(tokenHash: string, chatId: string, unsubscribeToken: string, now: Date): Promise<string | null> {
    const link = this.links.get(tokenHash)
    this.links.delete(tokenHash)
    if (link === undefined || link.expiresAt < now) return null
    this.rows.push({ id: this.nextId++, address: link.address, channel: 'telegram', target: chatId, confirmed: true, failures: 0, unsubscribeToken, confirmHash: null, confirmExpires: null })
    return link.address
  }
  async deleteContact(address: string, id: number): Promise<boolean> {
    const before = this.rows.length
    this.rows = this.rows.filter((row) => !(row.address === address && row.id === id))
    return this.rows.length < before
  }
  async unsubscribe(unsubscribeToken: string): Promise<Contact | null> {
    const row = this.rows.find((r) => r.unsubscribeToken === unsubscribeToken)
    if (row === undefined) return null
    this.rows = this.rows.filter((r) => r !== row)
    return row
  }
  async unlinkTelegram(chatId: string): Promise<number> {
    const before = this.rows.length
    this.rows = this.rows.filter((row) => !(row.channel === 'telegram' && row.target === chatId))
    return before - this.rows.length
  }
  async addressesOfChat(chatId: string): Promise<readonly string[]> {
    return this.rows.filter((row) => row.channel === 'telegram' && row.target === chatId).map((row) => row.address)
  }
  async deleteAddress(address: string): Promise<void> {
    this.rows = this.rows.filter((row) => row.address !== address)
    this.prefs.delete(address)
    for (const [hash, session] of this.sessions) if (session.address === address) this.sessions.delete(hash)
    for (const key of this.sent) if (key.startsWith(`${address}|`)) this.sent.delete(key)
  }
  async subscribedAddresses(): Promise<ReadonlySet<string>> {
    return new Set(this.rows.filter((row) => row.confirmed).map((row) => row.address))
  }
  async confirmedContacts(address: string): Promise<readonly Contact[]> {
    return this.rows.filter((row) => row.address === address && row.confirmed)
  }
  async wasSent(address: string, eventKey: string, contactId: number): Promise<boolean> {
    return this.sent.has(`${address}|${eventKey}|${contactId}`)
  }
  async markSent(address: string, eventKey: string, contactId: number): Promise<void> {
    this.sent.add(`${address}|${eventKey}|${contactId}`)
  }
  async recordFailure(contactId: number, max: number): Promise<number> {
    const row = this.rows.find((r) => r.id === contactId)
    if (row === undefined) return 0
    row.failures++
    if (row.failures >= max) this.rows = this.rows.filter((r) => r !== row)
    return row.failures
  }
  async clearFailures(contactId: number): Promise<void> {
    const row = this.rows.find((r) => r.id === contactId)
    if (row !== undefined) row.failures = 0
  }
  async loadCursor(): Promise<Cursor | null> {
    return this.cursor
  }
  async saveCursor(cursor: Cursor): Promise<void> {
    this.cursor = cursor
  }
  async sweep(): Promise<void> {}

  /** Test helper: a confirmed contact, no ceremony. */
  seed(address: string, channel: Contact['channel'], target: string, categories: readonly Category[] = ['renewal', 'market', 'transfer', 'chat']): Contact {
    const row: Row = { id: this.nextId++, address, channel, target, confirmed: true, failures: 0, unsubscribeToken: `unsub-${this.nextId}-token-token`, confirmHash: null, confirmExpires: null }
    this.rows.push(row)
    this.prefs.set(address, { renewal: categories.includes('renewal'), market: categories.includes('market'), transfer: categories.includes('transfer'), chat: categories.includes('chat') })
    return row
  }
}

export const asStore = (fake: FakeStore): Store => fake as unknown as Store
