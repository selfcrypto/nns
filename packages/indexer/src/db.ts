/**
 * Postgres connection and migrations.
 *
 * **Type parsing is configured once, here.** `pg` returns every integer wider
 * than 32 bits as a string by default. Two different rules apply:
 *
 * - **BIGINT (heights)** is parsed to `number`. Heights are `number`
 *   throughout this project and the chain is nowhere near 2^53.
 * - **NUMERIC (luna)** is deliberately left as a string, and every read of one
 *   goes through `toLuna`. Amounts are `bigint`, never `number`; a driver that
 *   handed back a `number` would round large amounts silently, which is the
 *   one arithmetic error this codebase is least able to notice.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'
import type { Pool, PoolClient } from 'pg'

import type { Logger } from './logger.js'

const INT8_OID = 20

pg.types.setTypeParser(INT8_OID, (value: string) => Number(value))

export class DatabaseError extends Error {
  override readonly name = 'DatabaseError'
}

export function createPool(connectionString: string): Pool {
  return new pg.Pool({ connectionString })
}

/** Run `work` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // The original error is the one worth reporting.
    }
    throw error
  } finally {
    client.release()
  }
}

/** Where the `.sql` files live, from either `src/` or `dist/`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url))

/**
 * Apply every migration not yet recorded, each in its own transaction with its
 * bookkeeping row — so a failure leaves the schema at a known version rather
 * than half-applied.
 */
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
    await withTransaction(pool, async (client) => {
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
    })
    logger?.info('db.migrated', { migration: file })
    ran.push(file)
  }
  if (ran.length === 0) logger?.debug('db.migrations.current', { count: files.length })
  return ran
}

/**
 * Multi-row insert, chunked under Postgres' 65,535-parameter ceiling.
 *
 * @param conflict e.g. `'(name) DO UPDATE SET ...'`, or omitted for a plain insert.
 */
export async function insertRows(
  client: PoolClient,
  table: string,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
  conflict?: string,
): Promise<void> {
  if (rows.length === 0) return
  const perChunk = Math.max(1, Math.floor(60_000 / columns.length))
  for (let start = 0; start < rows.length; start += perChunk) {
    const chunk = rows.slice(start, start + perChunk)
    const values: unknown[] = []
    const tuples = chunk.map((row) => {
      const placeholders = columns.map((column) => {
        values.push(row[column])
        return `$${values.length}`
      })
      return `(${placeholders.join(', ')})`
    })
    const onConflict = conflict === undefined ? '' : ` ON CONFLICT ${conflict}`
    await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}${onConflict}`,
      values,
    )
  }
}

/** `SET a = EXCLUDED.a, b = EXCLUDED.b, …` for an upsert. */
export function excluded(columns: readonly string[]): string {
  return columns.map((column) => `${column} = EXCLUDED.${column}`).join(', ')
}
