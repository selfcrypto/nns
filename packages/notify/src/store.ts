/**
 * Postgres: the six tables of `migrations/001_notify.sql` behind methods
 * named for what the service does, so the routes and the poller never see
 * SQL. Every method that removes personal data removes all of it: an
 * unsubscribe deletes the contact, `deleteAddress` deletes everything the
 * address ever gave.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'
import type { Pool } from 'pg'

import type { Category } from './events.js'
import type { Logger } from './logger.js'

const INT8_OID = 20
pg.types.setTypeParser(INT8_OID, (value: string) => Number(value))

export class StoreError extends Error {
  override readonly name = 'StoreError'
}

export function createPool(connectionString: string): Pool {
  return new pg.Pool({ connectionString })
}

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url))

export async function migrate(pool: Pool, logger?: Logger, directory = MIGRATIONS_DIR): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()
  const applied = new Set((await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((row) => row.name))
  const ran: string[] = []
  for (const file of files) {
    if (applied.has(file)) continue
    const sql = await readFile(join(directory, file), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    logger?.info('db.migrated', { migration: file })
    ran.push(file)
  }
  return ran
}

export type Channel = 'email' | 'telegram'

export interface Contact {
  readonly id: number
  readonly address: string
  readonly channel: Channel
  readonly target: string
  readonly confirmed: boolean
  readonly failures: number
  /** The one-click capability a message carries. */
  readonly unsubscribeToken: string
}

export type Preferences = Record<Category, boolean>

export const ALL_ON: Preferences = { renewal: true, market: true, transfer: true, chat: true }

export interface Cursor {
  readonly checkpointHeight: number
  readonly chatHeight: number | null
  readonly networkId: number
}

interface ContactRow {
  id: number
  address: string
  channel: Channel
  target: string
  confirmed: boolean
  failures: number
  unsubscribe_token: string
}

const toContact = (row: ContactRow): Contact => ({
  id: row.id,
  address: row.address,
  channel: row.channel,
  target: row.target,
  confirmed: row.confirmed,
  failures: row.failures,
  unsubscribeToken: row.unsubscribe_token,
})

const CONTACT_COLUMNS = 'id, address, channel, target, confirmed, failures, unsubscribe_token'

export class Store {
  private readonly pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  // ── sign-in ──────────────────────────────────────────────────────────────

  async createChallenge(nonce: string, address: string, text: string, expiresAt: Date): Promise<void> {
    await this.pool.query('INSERT INTO challenges (nonce, address, text, expires_at) VALUES ($1, $2, $3, $4)', [nonce, address, text, expiresAt])
  }

  /** Read and delete: a challenge is signed once. Null when unknown or expired. */
  async takeChallenge(nonce: string, now: Date): Promise<{ address: string; text: string } | null> {
    const { rows } = await this.pool.query<{ address: string; text: string; expires_at: Date }>(
      'DELETE FROM challenges WHERE nonce = $1 RETURNING address, text, expires_at',
      [nonce],
    )
    const row = rows[0]
    if (row === undefined || row.expires_at.getTime() < now.getTime()) return null
    return { address: row.address, text: row.text }
  }

  async createSession(tokenHash: string, address: string, expiresAt: Date): Promise<void> {
    await this.pool.query('INSERT INTO sessions (token_hash, address, expires_at) VALUES ($1, $2, $3)', [tokenHash, address, expiresAt])
  }

  /** The address behind a session token, or null. Touches `last_used`. */
  async sessionAddress(tokenHash: string, now: Date): Promise<string | null> {
    const { rows } = await this.pool.query<{ address: string }>(
      'UPDATE sessions SET last_used = $2 WHERE token_hash = $1 AND expires_at > $2 RETURNING address',
      [tokenHash, now],
    )
    return rows[0]?.address ?? null
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash])
  }

  // ── preferences ──────────────────────────────────────────────────────────

  async preferences(address: string): Promise<Preferences> {
    const { rows } = await this.pool.query<Preferences>('SELECT renewal, market, transfer, chat FROM preferences WHERE address = $1', [address])
    const row = rows[0]
    return row === undefined ? ALL_ON : { renewal: row.renewal, market: row.market, transfer: row.transfer, chat: row.chat }
  }

  async setPreferences(address: string, prefs: Preferences): Promise<void> {
    await this.pool.query(
      `INSERT INTO preferences (address, renewal, market, transfer, chat) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (address) DO UPDATE SET renewal = $2, market = $3, transfer = $4, chat = $5`,
      [address, prefs.renewal, prefs.market, prefs.transfer, prefs.chat],
    )
  }

  // ── contacts ─────────────────────────────────────────────────────────────

  async contacts(address: string): Promise<readonly Contact[]> {
    const { rows } = await this.pool.query<ContactRow>(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE address = $1 ORDER BY id`, [address])
    return rows.map(toContact)
  }

  /**
   * Add an email, unconfirmed, or re-issue the confirmation for one already
   * there. Returns the contact; the caller mails the (unhashed) token.
   */
  async addEmail(address: string, email: string, confirmHash: string, confirmExpires: Date, unsubscribeToken: string): Promise<Contact> {
    const { rows } = await this.pool.query<ContactRow>(
      `INSERT INTO contacts (address, channel, target, confirmed, confirm_hash, confirm_expires, unsubscribe_token)
       VALUES ($1, 'email', $2, FALSE, $3, $4, $5)
       ON CONFLICT (address, channel, target) DO UPDATE
         SET confirm_hash = CASE WHEN contacts.confirmed THEN contacts.confirm_hash ELSE $3 END,
             confirm_expires = CASE WHEN contacts.confirmed THEN contacts.confirm_expires ELSE $4 END
       RETURNING ${CONTACT_COLUMNS}`,
      [address, email, confirmHash, confirmExpires, unsubscribeToken],
    )
    const row = rows[0]
    if (row === undefined) throw new StoreError('addEmail returned no row')
    return toContact(row)
  }

  async confirmEmail(confirmHash: string, now: Date): Promise<Contact | null> {
    const { rows } = await this.pool.query<ContactRow>(
      `UPDATE contacts SET confirmed = TRUE, confirm_hash = NULL, confirm_expires = NULL, failures = 0
        WHERE confirm_hash = $1 AND confirm_expires > $2 AND NOT confirmed
        RETURNING ${CONTACT_COLUMNS}`,
      [confirmHash, now],
    )
    return rows[0] === undefined ? null : toContact(rows[0])
  }

  async createTelegramLink(tokenHash: string, address: string, expiresAt: Date): Promise<void> {
    await this.pool.query('INSERT INTO telegram_links (token_hash, address, expires_at) VALUES ($1, $2, $3)', [tokenHash, address, expiresAt])
  }

  /** `/start <token>` from a chat: bind it. Returns the address, or null for an unknown or expired token. */
  async bindTelegram(tokenHash: string, chatId: string, unsubscribeToken: string, now: Date): Promise<string | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ address: string; expires_at: Date }>(
        'DELETE FROM telegram_links WHERE token_hash = $1 RETURNING address, expires_at',
        [tokenHash],
      )
      const link = rows[0]
      if (link === undefined || link.expires_at.getTime() < now.getTime()) {
        await client.query('COMMIT')
        return null
      }
      await client.query(
        `INSERT INTO contacts (address, channel, target, confirmed, unsubscribe_token)
         VALUES ($1, 'telegram', $2, TRUE, $3)
         ON CONFLICT (address, channel, target) DO UPDATE SET confirmed = TRUE, failures = 0`,
        [link.address, chatId, unsubscribeToken],
      )
      await client.query('COMMIT')
      return link.address
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async deleteContact(address: string, id: number): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM contacts WHERE address = $1 AND id = $2', [address, id])
    return (result.rowCount ?? 0) > 0
  }

  /** The one-click unsubscribe: delete the contact the token names. */
  async unsubscribe(unsubscribeToken: string): Promise<Contact | null> {
    const { rows } = await this.pool.query<ContactRow>(`DELETE FROM contacts WHERE unsubscribe_token = $1 RETURNING ${CONTACT_COLUMNS}`, [unsubscribeToken])
    return rows[0] === undefined ? null : toContact(rows[0])
  }

  /** `/stop` from a chat: every address bound to it. Returns how many. */
  async unlinkTelegram(chatId: string): Promise<number> {
    const result = await this.pool.query(`DELETE FROM contacts WHERE channel = 'telegram' AND target = $1`, [chatId])
    return result.rowCount ?? 0
  }

  async addressesOfChat(chatId: string): Promise<readonly string[]> {
    const { rows } = await this.pool.query<{ address: string }>(`SELECT address FROM contacts WHERE channel = 'telegram' AND target = $1 ORDER BY address`, [chatId])
    return rows.map((row) => row.address)
  }

  /** Everything about an address: contacts, preferences, sessions, the send ledger. */
  async deleteAddress(address: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const table of ['contacts', 'preferences', 'sessions', 'sent', 'telegram_links', 'challenges']) {
        await client.query(`DELETE FROM ${table} WHERE address = $1`, [address])
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  // ── delivery ─────────────────────────────────────────────────────────────

  /** Every address with at least one confirmed contact: who the tails filter for. */
  async subscribedAddresses(): Promise<ReadonlySet<string>> {
    const { rows } = await this.pool.query<{ address: string }>('SELECT DISTINCT address FROM contacts WHERE confirmed')
    return new Set(rows.map((row) => row.address))
  }

  async confirmedContacts(address: string): Promise<readonly Contact[]> {
    const { rows } = await this.pool.query<ContactRow>(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE address = $1 AND confirmed ORDER BY id`, [address])
    return rows.map(toContact)
  }

  async wasSent(address: string, eventKey: string, contactId: number): Promise<boolean> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM sent WHERE address = $1 AND event_key = $2 AND contact_id = $3', [address, eventKey, contactId])
    return (rowCount ?? 0) > 0
  }

  async markSent(address: string, eventKey: string, contactId: number): Promise<void> {
    await this.pool.query('INSERT INTO sent (address, event_key, contact_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [address, eventKey, contactId])
  }

  /** Count a refused delivery; the contact is gone once it reaches `max`. Returns the new count. */
  async recordFailure(contactId: number, max: number): Promise<number> {
    const { rows } = await this.pool.query<{ failures: number }>('UPDATE contacts SET failures = failures + 1 WHERE id = $1 RETURNING failures', [contactId])
    const failures = rows[0]?.failures ?? 0
    if (failures >= max) await this.pool.query('DELETE FROM contacts WHERE id = $1', [contactId])
    return failures
  }

  async clearFailures(contactId: number): Promise<void> {
    await this.pool.query('UPDATE contacts SET failures = 0 WHERE id = $1 AND failures > 0', [contactId])
  }

  // ── cursor and housekeeping ──────────────────────────────────────────────

  async loadCursor(): Promise<Cursor | null> {
    const { rows } = await this.pool.query<{ checkpoint_height: number; chat_height: number | null; network_id: number }>(
      'SELECT checkpoint_height, chat_height, network_id FROM cursor WHERE id',
    )
    const row = rows[0]
    return row === undefined ? null : { checkpointHeight: row.checkpoint_height, chatHeight: row.chat_height, networkId: row.network_id }
  }

  async saveCursor(cursor: Cursor): Promise<void> {
    await this.pool.query(
      `INSERT INTO cursor (id, checkpoint_height, chat_height, network_id, updated_at) VALUES (TRUE, $1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET checkpoint_height = $1, chat_height = $2, network_id = $3, updated_at = now()`,
      [cursor.checkpointHeight, cursor.chatHeight, cursor.networkId],
    )
  }

  /** Expired challenges, deep links, sessions and unconfirmed emails. */
  async sweep(now: Date): Promise<void> {
    await this.pool.query('DELETE FROM challenges WHERE expires_at < $1', [now])
    await this.pool.query('DELETE FROM telegram_links WHERE expires_at < $1', [now])
    await this.pool.query('DELETE FROM sessions WHERE expires_at < $1', [now])
    await this.pool.query('DELETE FROM contacts WHERE NOT confirmed AND confirm_expires < $1', [now])
  }
}
