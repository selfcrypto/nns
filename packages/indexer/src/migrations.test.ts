/**
 * A schema that stopped at an earlier migration, brought up to date.
 *
 * Every other suite runs `migrate()` on an empty schema, which is a fresh
 * install. A deploy is the other case: a database that already holds some of
 * the migrations takes the rest, and that path had no test.
 *
 * **Needs a real Postgres**, and is skipped without one:
 *
 *   NNS_TEST_DATABASE_URL=postgres://…/nns_test pnpm vitest run --project indexer
 *
 * Its own named schema, for `store.test.ts`'s reason.
 */

import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPool, migrate, MIGRATIONS_DIR } from './db.js'
import { collectingLogger } from './test-fixtures.js'

const URL = process.env['NNS_TEST_DATABASE_URL']

const SCHEMA = 'migrations_test'
const POOL_URL =
  URL === undefined ? '' : `${URL}${URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`

describe.skipIf(URL === undefined)('migrate, resumed', () => {
  const pool = createPool(POOL_URL)
  const { logger } = collectingLogger()
  let files: string[] = []
  let scratch = ''

  /** A directory holding the first `count` migrations: the schema as an older build knew it. */
  const upTo = async (count: number): Promise<string> => {
    const directory = join(scratch, String(count))
    await rm(directory, { recursive: true, force: true })
    await mkdir(directory, { recursive: true })
    for (const file of files.slice(0, count)) await copyFile(join(MIGRATIONS_DIR, file), join(directory, file))
    return directory
  }

  const empty = async (): Promise<void> => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`)
  }

  /** Every column and every constraint, as text: two schemas are the same when these are. */
  const shape = async (): Promise<{ columns: string[]; constraints: string[] }> => {
    const columns = await pool.query<{ line: string }>(
      `SELECT table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '-') AS line
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name <> 'schema_migrations'
        ORDER BY 1`,
      [SCHEMA],
    )
    const constraints = await pool.query<{ line: string }>(
      `SELECT rel.relname || ' ' || con.conname || ' ' || pg_get_constraintdef(con.oid) AS line
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = rel.relnamespace
        WHERE ns.nspname = $1 AND rel.relname <> 'schema_migrations'
        ORDER BY 1`,
      [SCHEMA],
    )
    return { columns: columns.rows.map((row) => row.line), constraints: constraints.rows.map((row) => row.line) }
  }

  beforeAll(async () => {
    files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort()
    scratch = await mkdtemp(join(tmpdir(), 'nns-migrations-'))
  })
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.end()
    await rm(scratch, { recursive: true, force: true })
  })

  it('applies only what is missing, in order, and lands on the schema a fresh install has', async () => {
    await empty()
    expect(await migrate(pool, logger)).toEqual(files)
    const fresh = await shape()
    expect(fresh.columns.length).toBeGreaterThan(0)

    for (let count = 1; count < files.length; count++) {
      await empty()
      expect(await migrate(pool, logger, await upTo(count)), `first ${count}`).toEqual(files.slice(0, count))
      expect(await migrate(pool, logger), `resumed from ${files[count - 1]}`).toEqual(files.slice(count))
      expect(await shape(), `resumed from ${files[count - 1]}`).toEqual(fresh)
    }
  })

  it('applies nothing to a schema that is current', async () => {
    await empty()
    await migrate(pool, logger)
    expect(await migrate(pool, logger)).toEqual([])
    const recorded = await pool.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')
    expect(recorded.rows.map((row) => row.name)).toEqual(files)
  })

  // The one migration that renames a column holding a value: the price a
  // pre-fold database had governed must still be there under the new name.
  it('carries a governed price across the rename in 012', async () => {
    const at = files.findIndex((name) => name.startsWith('012_'))
    expect(at).toBeGreaterThan(0)
    await empty()
    await migrate(pool, logger, await upTo(at))
    await pool.query(
      `INSERT INTO params (fee_standard, fee_long, commission_bp, state_height) VALUES (200000000, 40000000, 250, 61344720)`,
    )
    await migrate(pool, logger)
    const row = await pool.query<{ fee_base: string; commission_bp: string; state_height: number }>(
      'SELECT fee_base, commission_bp, state_height FROM params',
    )
    expect(row.rows).toEqual([{ fee_base: '40000000', commission_bp: '250', state_height: 61_344_720 }])
  })
})
