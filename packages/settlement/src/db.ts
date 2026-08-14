/**
 * Postgres for the ledger, and **only** for the ledger.
 *
 * The connection plumbing is `@nns/indexer`'s — `createPool`, `migrate`,
 * `withTransaction`, and the `pg` type-parser configuration that makes BIGINT a
 * `number` and leaves NUMERIC a string so no luna amount is ever a `number`.
 * Sharing that code is not sharing a database: this pool opens
 * `NNS_SETTLEMENT_DATABASE_URL`, which is its own database in its own
 * container, and the rule this package lives under is about *data*, not about
 * `pg` boilerplate.
 *
 * **`MIGRATIONS_DIR` is re-exported deliberately shadowing the indexer's.**
 * `migrate(pool)` with the argument omitted applies the *indexer's* migrations
 * to whatever database it is handed, which against this one would create
 * `names`, `log` and `checkpoints` in the ledger's database and leave a
 * plausible-looking half-indexer nobody writes to. `migrateLedger` takes no
 * directory parameter for that reason: there is one directory it can mean.
 *
 * Nothing else in this package imports this file. `reconcile-main.ts` and
 * `watch-main.ts` must keep starting on a box with no database at all, which
 * stays true by inspection as long as the import graph says so — there is a
 * test that walks it.
 */

import { fileURLToPath } from 'node:url'

import { createPool, migrate, withTransaction, type Logger } from '@nns/indexer'
import type { Pool } from 'pg'

export { createPool, withTransaction }
export type { Pool }

/** This package's `migrations/`, from either `src/` or `dist/`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url))

/** Apply the ledger's migrations, and only ever the ledger's. */
export function migrateLedger(pool: Pool, logger?: Logger): Promise<string[]> {
  return migrate(pool, logger, MIGRATIONS_DIR)
}
