/**
 * Entrypoint.
 *
 *   pnpm --filter @nns/indexer dev      # node --env-file=.env src/main.ts
 *
 * Reads `.env` (see `.env.example`), migrates the database, reloads state and
 * the cursor, then tails batches up to the last finalised macro block —
 * reducing each batch's messages through `@nns/core` and committing state, log
 * lines, §8.1 checkpoints and the cursor in one transaction per batch.
 *
 * In a container this is `node dist/main.js` with the environment supplied by
 * `docker-compose.yml`; `--env-file` is the local-development path only.
 */

import { CONSTANTS } from '@nns/core'
import { CheckpointBuilder } from './checkpoint.js'
import { createLogger, type Logger } from './logger.js'
import { EnvError, loadSettings, type IndexerSettings } from './env.js'
import { createPool, migrate } from './db.js'
import { HorizonError } from './horizon.js'
import { Pipeline } from './pipeline.js'
import { Progress } from './progress.js'
import { RpcClient } from './rpc.js'
import { nameRows } from './rows.js'
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
    launchHeight: CONSTANTS.LAUNCH_HEIGHT,
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
    // §8.1 boundaries are absolute multiples of CHECKPOINT_INTERVAL from
    // LAUNCH_HEIGHT on, and LAUNCH_HEIGHT can be one of them — a boundary at a
    // height the reloaded state has already reached. What the database holds
    // is what says whether it has been committed already.
    const latestCheckpoint = await store.latestCheckpoint()

    // The §8.2 log hash is a fold over every line ever written, and state is
    // reloaded rather than replayed — so the fold is rebuilt from the `log`
    // table before the first new batch can produce a checkpoint.
    const checkpoints = new CheckpointBuilder({ logger })
    await store.streamLogRows((row) => checkpoints.seed(row))
    checkpoints.seeded()

    const rpc = new RpcClient({
      url: settings.rpcUrl,
      username: settings.rpcUser,
      password: settings.rpcPassword,
      timeoutMs: settings.rpcTimeoutMs,
      attempts: settings.rpcAttempts,
      logger,
    })
    const pipeline = new Pipeline(settings.config, logger, {
      ...(latestCheckpoint === null ? {} : { lastCheckpointHeight: latestCheckpoint.height }),
    })
    // Declared before the scanner so its `target` can read the scanner's view
    // of the chain head; assigned after, since the two refer to each other.
    let scanner: Scanner
    const progress = new Progress({
      logger,
      intervalMs: settings.progressIntervalMs,
      target: () => scanner.finalisedBatch,
      startHeight: state.height,
    })

    scanner = new Scanner({
      rpc,
      logger,
      networkId: settings.networkId,
      launchHeight: CONSTANTS.LAUNCH_HEIGHT,
      pollIntervalMs: settings.pollIntervalMs,
      ...(cursor === null ? {} : { startBatch: cursor.nextBatch }),
      onBatchComplete: async ({ batch, macroBlock, candidates }) => {
        const before = state
        const result = pipeline.applyBatch(before, candidates, macroBlock)
        // Built before the commit and written inside it: a checkpoint and the
        // log rows it commits to land together or not at all. A throw from
        // here is fatal by design — the running log hash would be ahead of the
        // table, and a restart reseeds it from the table.
        const due = checkpoints.buildForBatch(result)
        // The proof snapshot follows the highest boundary this batch crossed
        // (migration 005) — the API serves §8.3 proofs from it.
        const boundary = result.boundariesCrossed[result.boundariesCrossed.length - 1]
        await store.commitBatch({
          before,
          after: result.state,
          logRows: result.logRows,
          checkpoints: due,
          ...(boundary === undefined
            ? {}
            : { snapshot: { height: boundary.height, names: nameRows(boundary.state) } }),
          nextBatch: batch + 1,
          scannedThrough: macroBlock,
        })
        state = result.state
        progress.batchCommitted(batch, macroBlock, result, due)
      },
    })

    installSignalHandlers(logger, controller)
    await scanner.run(controller.signal)
    // The run's totals, whatever the heartbeat's cadence had reached.
    progress.flush('stop')
    logger.info('indexer.stop', { nextBatch: scanner.nextBatch, height: state.height })
  } finally {
    await pool.end()
  }
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
  // The node not holding LAUNCH_HEIGHT is the same class of problem as a bad
  // .env — the configuration and the node disagree — so it exits 2 like one,
  // and its own message already names both heights.
  if (error instanceof HorizonError) {
    process.stderr.write(`indexer: ${error.message}\n`)
    process.exitCode = 2
  } else {
    // A daemon that cannot reach its database or its node should say so in one
    // line, not in a driver stack trace.
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    process.stderr.write(`indexer: ${message}\n`)
    process.exitCode = 1
  }
}
