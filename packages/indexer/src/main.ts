/**
 * Entrypoint.
 *
 *   pnpm --filter @nns/indexer dev      # node --env-file=.env src/main.ts
 *
 * Reads `.env` (see `.env.example`), migrates the database, reloads state and
 * the cursor, then tails batches up to the last finalised macro block —
 * reducing each batch's messages through `@nns/core` and committing state, log
 * lines and the cursor in one transaction per batch.
 *
 * Not here yet: the checkpoint builder and `docker-compose.yml`.
 */

import { createLogger, type Logger } from './logger.js'
import { EnvError, loadSettings, type IndexerSettings } from './env.js'
import { createPool, migrate } from './db.js'
import { Pipeline, type BatchResult } from './pipeline.js'
import { RpcClient } from './rpc.js'
import { Scanner } from './scan.js'
import { Store } from './store.js'

async function main(): Promise<void> {
  // A long-running daemon must not die because whatever was reading its
  // stdout went away (`| head`, a detached tail, a restarted log shipper).
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error
  })

  let settings: IndexerSettings
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

  const logger = createLogger({ level: settings.logLevel, base: { component: 'indexer' } })
  logger.info('indexer.start', {
    rpcUrl: settings.rpcUrl,
    authenticated: settings.rpcUser !== undefined,
    networkId: settings.networkId,
    launchHeight: settings.launchHeight,
    pollIntervalMs: settings.pollIntervalMs,
  })

  const pool = createPool(settings.databaseUrl)
  const controller = new AbortController()
  try {
    await migrate(pool, logger)

    const store = new Store(pool, settings.config, logger)
    // Throws if the database was built under different §3 values.
    const cursor = await store.loadCursor()
    let state = await store.loadState()

    const rpc = new RpcClient({
      url: settings.rpcUrl,
      username: settings.rpcUser,
      password: settings.rpcPassword,
      timeoutMs: settings.rpcTimeoutMs,
      attempts: settings.rpcAttempts,
      logger,
    })
    const pipeline = new Pipeline(settings.config, logger)

    const scanner = new Scanner({
      rpc,
      logger,
      networkId: settings.networkId,
      launchHeight: settings.launchHeight,
      pollIntervalMs: settings.pollIntervalMs,
      ...(cursor === null ? {} : { startBatch: cursor.nextBatch }),
      onBatchComplete: async ({ batch, macroBlock, candidates }) => {
        const before = state
        const result = pipeline.applyBatch(before, candidates, macroBlock)
        await store.commitBatch({
          before,
          after: result.state,
          logRows: result.logRows,
          nextBatch: batch + 1,
          scannedThrough: macroBlock,
        })
        state = result.state
        report(logger, batch, macroBlock, result)
      },
    })

    installSignalHandlers(logger, controller)
    await scanner.run(controller.signal)
    logger.info('indexer.stop', { nextBatch: scanner.nextBatch, height: state.height })
  } finally {
    await pool.end()
  }
}

function report(logger: Logger, batch: number, macroBlock: number, result: BatchResult): void {
  const interesting = result.logRows.length > 0 || result.boundariesCrossed.length > 0
  const line = {
    batch,
    height: macroBlock,
    stateHeight: result.state.height,
    names: result.state.names.size,
    logged: result.logRows.length,
    ...result.counts,
    boundaries: result.boundariesCrossed.length,
  }
  if (interesting) logger.info('reduce.batch', line)
  else logger.debug('reduce.batch', line)
}

function installSignalHandlers(logger: Logger, controller: AbortController): void {
  const stop = (signal: string) => () => {
    logger.info('indexer.signal', { signal })
    controller.abort()
  }
  process.once('SIGINT', stop('SIGINT'))
  process.once('SIGTERM', stop('SIGTERM'))
}

try {
  await main()
} catch (error) {
  // A daemon that cannot reach its database or its node should say so in one
  // line, not in a driver stack trace.
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  process.stderr.write(`indexer: ${message}\n`)
  process.exitCode = 1
}
