/**
 * Entrypoint.
 *
 *   pnpm --filter @nns/indexer dev      # builds, then node --env-file=.env dist/main.js
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
import { createAnchorReadRpc } from '@nns/anchor/reader'
import { bootstrap } from './bootstrap.js'
import { CheckpointBuilder } from './checkpoint.js'
import { createLogger, type Logger } from './logger.js'
import { EnvError, loadSettings, type IndexerSettings } from './env.js'
import { createPool, migrate } from './db.js'
import { assertHistoryHorizon, HorizonError } from './horizon.js'
import { Pipeline } from './pipeline.js'
import { Progress } from './progress.js'
import { RpcClient } from './rpc.js'
import { nameRows } from './rows.js'
import { Scanner } from './scan.js'
import { verifyFromChain } from './shadow.js'
import { anchoredSource } from './anchored.js'
import { httpFetcher, peerSource, type LogSource } from './peer.js'
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
    startMode: settings.startMode,
  })

  const pool = createPool(settings.databaseUrl)
  const controller = new AbortController()
  try {
    await migrate(pool, logger)

    const store = new Store(pool, settings.config, logger)
    const rpc = new RpcClient({
      url: settings.rpcUrl,
      username: settings.rpcUser,
      password: settings.rpcPassword,
      timeoutMs: settings.rpcTimeoutMs,
      attempts: settings.rpcAttempts,
      logger,
    })

    // Throws if the database was built under different §3 values.
    let cursor = await store.loadCursor()
    if (settings.startMode !== 'scratch' && settings.snapshotUrl !== undefined) {
      if (cursor === null) {
        // `hybrid` re-derives from LAUNCH_HEIGHT, so it needs a node that still
        // holds it. Checked here, before a row is written: the same refusal
        // arriving an hour later, from the background sweep, would leave a
        // bootstrapped database behind that nobody asked for.
        if (settings.startMode === 'hybrid') {
          await assertHistoryHorizon({
            rpc,
            startHeight: CONSTANTS.LAUNCH_HEIGHT,
            origin: 'LAUNCH_HEIGHT, which NNS_START_MODE=hybrid re-derives from',
            logger,
          })
        }
        await bootstrap({
          store,
          rpc,
          logger,
          config: settings.config,
          launchHeight: CONSTANTS.LAUNCH_HEIGHT,
          source: await logSource(settings, logger),
        })
        cursor = await store.loadCursor()
      } else {
        // The mode says how an empty database is seeded, and this one is not
        // empty. Said out loud rather than ignored: an operator who set it
        // expecting a re-seed should not have to infer from the batch rate
        // that nothing happened.
        logger.info('bootstrap.skipped', {
          startMode: settings.startMode,
          reason: 'the database already has a cursor — state is never re-seeded',
          nextBatch: cursor.nextBatch,
        })
      }
    }

    const verification = await store.loadVerification()
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

    // `hybrid` runs the §8.4 Tier 3 replay beside the tail, and it runs on
    // every start while an unverified range remains — not only on the start
    // that bootstrapped. An operator who seeded with `snapshot` and set
    // `hybrid` afterwards gets the sweep, which is the useful reading of a
    // mode that describes what this indexer is doing rather than what it did
    // once.
    let verificationFailure: unknown
    const sweep =
      settings.startMode === 'hybrid' &&
      verification !== null &&
      verification.bootstrapHeight !== null &&
      verification.verifiedFrom > CONSTANTS.LAUNCH_HEIGHT
        ? verifyFromChain(
            {
              rpc,
              store,
              logger,
              config: settings.config,
              networkId: settings.networkId,
              launchHeight: CONSTANTS.LAUNCH_HEIGHT,
              pollIntervalMs: settings.pollIntervalMs,
              throughHeight: verification.bootstrapHeight,
            },
            controller.signal,
          ).catch((error: unknown) => {
            // A sweep that disagrees with the stored state has caught the one
            // failure this design exists to catch. Stop the tail rather than
            // keep serving rows a replay of the chain does not reproduce.
            verificationFailure = error
            controller.abort()
          })
        : Promise.resolve()

    await scanner.run(controller.signal)
    await sweep
    // The run's totals, whatever the heartbeat's cadence had reached.
    progress.flush('stop')
    logger.info('indexer.stop', { nextBatch: scanner.nextBatch, height: state.height })
    if (verificationFailure !== undefined) throw verificationFailure
  } finally {
    await pool.end()
  }
}

/**
 * The log a bootstrap replays, and the §8.1 commitment it must reproduce.
 *
 * Two sources, and the choice is about **where the expected commitment comes
 * from**, not about where the bytes come from. `peer` asks one operator for
 * both; `anchor` takes the commitment off the §9 contract — cross-checked
 * across publishers and RPC endpoints — and then fetches the bytes from any
 * IPFS gateway, trusting the gateway for nothing.
 */
async function logSource(settings: IndexerSettings, logger: Logger): Promise<LogSource> {
  const url = settings.snapshotUrl as string
  if (settings.snapshotSource === 'peer') return await peerSource(url, httpFetcher)
  return await anchoredSource({
    rpcs: settings.anchorRpcUrls.map((endpoint) => createAnchorReadRpc(endpoint)),
    contractAddress: settings.anchorContract as string,
    publishers: settings.anchorPublishers,
    quorum: settings.anchorQuorum,
    ...(settings.anchorLookbackBlocks === undefined
      ? {}
      : { lookbackBlocks: settings.anchorLookbackBlocks }),
    gateway: url,
    fetcher: httpFetcher,
    logger,
  })
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
