/**
 * Entrypoint: migrate, resume, tail batches, serve reads.
 *
 * Nothing here can affect the registry. Separate process, separate database,
 * separate schema — if this service is stopped, broken or never deployed, the
 * NNS indexer, the log and every root are exactly as they were, and the app
 * falls back to reading the chain itself.
 */

import { EnvError, loadSettings, type ChatIndexSettings } from './env.js'
import { createLogger, type Logger } from './logger.js'
import { RpcClient, RpcError } from './rpc.js'
import { Scanner, StartAheadOfHead } from './scan.js'
import { createChatServer } from './server.js'
import { Store, createPool, migrate } from './store.js'

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

async function main(): Promise<void> {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error
  })

  let settings: ChatIndexSettings
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

  const logger: Logger = createLogger(settings.logLevel)
  const pool = createPool(settings.databaseUrl)
  const controller = new AbortController()

  try {
    await migrate(pool, logger)
    const store = new Store(pool, logger)
    const stored = await store.loadCursor()

    if (stored !== null && stored.startHeight !== settings.startHeight) {
      // The window is what every reader is told. Moving it under a database
      // that was filled against the old one would make that statement false:
      // raising it hides rows that are there, lowering it claims rows that
      // were never scanned.
      logger.error('chat.start-height.changed', { stored: stored.startHeight, configured: settings.startHeight })
      process.stderr.write(
        `NNS_CHAT_START_HEIGHT is ${settings.startHeight} but this database was built from ` +
          `${stored.startHeight}. Use the stored height, or start a fresh database — the chain is the source, ` +
          `so rebuilding costs only a re-scan.\n`,
      )
      process.exitCode = 2
      return
    }
    if (stored !== null && stored.networkId !== settings.networkId) {
      logger.error('chat.network.changed', { stored: stored.networkId, configured: settings.networkId })
      process.stderr.write(`this database was built against network ${stored.networkId}\n`)
      process.exitCode = 2
      return
    }

    const rpc = new RpcClient({
      url: settings.rpcUrl,
      username: settings.rpcUser,
      password: settings.rpcPassword,
      timeoutMs: settings.rpcTimeoutMs,
    })

    const scanner = new Scanner({
      rpc,
      logger,
      networkId: settings.networkId,
      startHeight: settings.startHeight,
      startBatch: stored?.nextBatch,
      onBatch: (scan, nextBatch) =>
        store.commitBatch(scan.rows, {
          nextBatch,
          startHeight: settings.startHeight,
          networkId: settings.networkId,
        }),
    })

    const server = createChatServer({
      store,
      logger,
      maxPageSize: settings.maxPageSize,
      startHeight: settings.startHeight,
      scannedTo: () => scanner.nextBatch,
    })
    server.listen(settings.port, () => logger.info('chat.listening', { port: settings.port }))

    const stop = (): void => {
      controller.abort()
      server.close()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)

    logger.info('chat.start', {
      rpcUrl: settings.rpcUrl,
      networkId: settings.networkId,
      startHeight: settings.startHeight,
      resumed: stored !== null,
    })

    while (!controller.signal.aborted) {
      try {
        const scanned = await scanner.tick(controller.signal)
        if (controller.signal.aborted) break
        if (scanned === 0) await sleep(settings.pollIntervalMs, controller.signal)
      } catch (error) {
        if (controller.signal.aborted) break
        if (error instanceof StartAheadOfHead) {
          logger.info('chat.waiting', { reason: 'start height not reached', startHeight: error.startHeight, head: error.head })
          await sleep(settings.pollIntervalMs, controller.signal)
          continue
        }
        // A start height the node no longer holds is not transient: retrying
        // would index a silent gap forever. Everything else is.
        if (error instanceof RpcError && error.answered && scanner.nextBatch === undefined) {
          logger.error('chat.horizon', { startHeight: settings.startHeight, error })
          process.stderr.write(
            `the node does not hold block ${settings.startHeight}. Raise NNS_CHAT_START_HEIGHT to a height ` +
              `it still has — an index that starts below the horizon finds nothing, reproducibly.\n`,
          )
          process.exitCode = 2
          stop()
          break
        }
        logger.error('chat.error', { nextBatch: scanner.nextBatch, error })
        await sleep(settings.pollIntervalMs, controller.signal)
      }
    }
  } finally {
    await pool.end()
  }
}

await main()
