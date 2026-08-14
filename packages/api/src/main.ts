/**
 * Entrypoint.
 *
 *   pnpm --filter @nns/api dev      # builds, then node --env-file=.env dist/main.js
 *
 * Read-only by construction: the pool is only ever handed to `PgQueries`,
 * which opens every transaction `READ ONLY`, and this process never migrates
 * — the indexer owns the schema. Until the indexer has initialised the
 * database, every endpoint answers 503 `NOT_SYNCED` rather than refusing to
 * start: safe to boot in any order, including against a read replica that is
 * still catching up.
 */

import { createLogger, createPool } from '@nns/indexer'

import { EnvError, loadSettings, type ApiSettings } from './env.js'
import { PgQueries } from './queries.js'
import { createRoutes } from './routes.js'
import { createServer } from './server.js'

async function main(): Promise<void> {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error
  })

  let settings: ApiSettings
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

  const logger = createLogger({ level: settings.logLevel, base: { component: 'api' } })
  const pool = createPool(settings.databaseUrl)
  const handle = createRoutes(new PgQueries(pool))
  const server = createServer(handle, logger)

  server.listen(settings.port, settings.host, () => {
    logger.info('api.start', { host: settings.host, port: settings.port })
  })

  const shutdown = (): void => {
    logger.info('api.stop')
    server.close(() => {
      pool.end().catch(() => {
        // Already going down; nothing useful left to do with this error.
      })
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exitCode = 1
})
