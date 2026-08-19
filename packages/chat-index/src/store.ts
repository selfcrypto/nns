/**
 * Postgres: migrations, the message table, the cursor.
 *
 * `pg` hands back BIGINT as a string; heights and millisecond timestamps are
 * `number` throughout this project and the chain is nowhere near 2^53, so the
 * parser is set once here. There are no luna amounts in this schema — chat
 * carries dust and text — which is why the indexer's NUMERIC caution has no
 * counterpart in this file.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'
import type { Pool } from 'pg'

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
  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((row) => row.name),
  )
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

export interface ChatRow {
  readonly txHash: string
  readonly blockNumber: number
  readonly timestamp: number
  readonly sender: string
  readonly recipient: string
  readonly name: string
  readonly message: string
  readonly recipientData: string
}

export interface CursorRow {
  readonly nextBatch: number
  readonly startHeight: number
  readonly networkId: number
}

export class Store {
  private readonly pool: Pool
  private readonly logger: Logger

  constructor(pool: Pool, logger: Logger) {
    this.pool = pool
    this.logger = logger
  }

  async loadCursor(): Promise<CursorRow | null> {
    const { rows } = await this.pool.query<{ next_batch: number; start_height: number; network_id: number }>(
      'SELECT next_batch, start_height, network_id FROM chat_cursor WHERE id',
    )
    const row = rows[0]
    return row === undefined
      ? null
      : { nextBatch: row.next_batch, startHeight: row.start_height, networkId: row.network_id }
  }

  /**
   * Rows and cursor in one transaction, so a crash mid-batch re-scans that
   * batch rather than skipping it. Re-scanning is free: `tx_hash` is the
   * primary key and the insert does nothing on conflict, so the same batch
   * applied twice is the same database.
   */
  async commitBatch(rows: readonly ChatRow[], cursor: CursorRow): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const row of rows) {
        await client.query(
          `INSERT INTO chat_messages
             (tx_hash, block_number, timestamp, sender, recipient, name, message, recipient_data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (tx_hash) DO NOTHING`,
          [
            row.txHash,
            row.blockNumber,
            row.timestamp,
            row.sender,
            row.recipient,
            row.name,
            row.message,
            row.recipientData,
          ],
        )
      }
      await client.query(
        `INSERT INTO chat_cursor (id, next_batch, start_height, network_id, updated_at)
         VALUES (TRUE, $1, $2, $3, now())
         ON CONFLICT (id) DO UPDATE SET next_batch = EXCLUDED.next_batch, updated_at = now()`,
        [cursor.nextBatch, cursor.startHeight, cursor.networkId],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    if (rows.length > 0) this.logger.info('chat.stored', { rows: rows.length, nextBatch: cursor.nextBatch })
  }

  /**
   * Messages involving an address, newest first. `before` is an exclusive
   * block-number cursor, which is coarse on purpose: a page boundary inside a
   * block would need a composite cursor to be stable, and the caller wants
   * whole conversations rather than an exact offset.
   */
  async messagesFor(address: string, limit: number, before: number | null): Promise<readonly ChatRow[]> {
    const { rows } = await this.pool.query<{
      tx_hash: string
      block_number: number
      timestamp: number
      sender: string
      recipient: string
      name: string
      message: string
      recipient_data: string
    }>(
      `SELECT tx_hash, block_number, timestamp, sender, recipient, name, message, recipient_data
         FROM chat_messages
        WHERE (sender = $1 OR recipient = $1)
          AND ($2::bigint IS NULL OR block_number < $2)
        ORDER BY block_number DESC, tx_hash DESC
        LIMIT $3`,
      [address, before, limit],
    )
    return rows.map((row) => ({
      txHash: row.tx_hash,
      blockNumber: row.block_number,
      timestamp: row.timestamp,
      sender: row.sender,
      recipient: row.recipient,
      name: row.name,
      message: row.message,
      recipientData: row.recipient_data,
    }))
  }
}
