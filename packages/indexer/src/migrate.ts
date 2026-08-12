/**
 * Migration CLI.
 *
 *   pnpm --filter @nns/indexer migrate
 *
 * `main.ts` also migrates on startup, so this exists for the case where the
 * schema should move without the indexer running — a deploy step, or checking
 * what a fresh database looks like.
 */

import { createLogger } from './logger.js'
import { EnvError, loadSettings } from './env.js'
import { createPool, migrate } from './db.js'

async function main(): Promise<void> {
  let settings
  try {
    settings = loadSettings()
  } catch (error) {
    if (error instanceof EnvError) {
      process.stderr.write(`configuration: ${error.message}\n`)
      process.exitCode = 2
      return
    }
    throw error
  }

  const logger = createLogger({ level: settings.logLevel, base: { component: 'migrate' } })
  const pool = createPool(settings.databaseUrl)
  try {
    const ran = await migrate(pool, logger)
    logger.info('migrate.done', { applied: ran.length, migrations: ran })
  } finally {
    await pool.end()
  }
}

await main()
