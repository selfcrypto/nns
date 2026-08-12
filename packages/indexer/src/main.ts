/**
 * Entrypoint.
 *
 *   pnpm --filter @nns/indexer dev      # node --env-file=.env src/main.ts
 *
 * Reads `.env` (see `.env.example`), opens the RPC, and tails batches up to
 * the last finalised macro block, logging every `NNS1`-prefixed transaction
 * it finds. It persists nothing: this is the chain-facing half.
 */

import { createLogger } from './logger.js'
import { EnvError, loadSettings, type IndexerSettings } from './env.js'
import { RpcClient } from './rpc.js'
import { Scanner } from './scan.js'

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

  const rpc = new RpcClient({
    url: settings.rpcUrl,
    username: settings.rpcUser,
    password: settings.rpcPassword,
    timeoutMs: settings.rpcTimeoutMs,
    attempts: settings.rpcAttempts,
    logger,
  })

  const scanner = new Scanner({
    rpc,
    logger,
    networkId: settings.networkId,
    launchHeight: settings.launchHeight,
    pollIntervalMs: settings.pollIntervalMs,
  })

  const controller = new AbortController()
  const stop = (signal: string) => () => {
    logger.info('indexer.signal', { signal })
    controller.abort()
  }
  process.once('SIGINT', stop('SIGINT'))
  process.once('SIGTERM', stop('SIGTERM'))

  await scanner.run(controller.signal)
  logger.info('indexer.stop', { nextBatch: scanner.nextBatch })
}

await main()
