/**
 * Entrypoint.
 *
 *   pnpm --filter @nns/delegate dev    # builds, then node --env-file=.env dist/main.js
 *
 * Boot order is deliberate: the labels file is read and validated *before* the
 * socket opens. A delegate that starts on a broken file and answers 404 for
 * every label is, to a client, indistinguishable from one that is merely
 * empty — and by §8.6's design no client can be told the difference. So a bad
 * file at boot exits 2 with the offending key, and only a file already serving
 * can survive a bad edit (`store.ts`).
 */

import { EnvError, loadSettings, type DelegateSettings } from './env.js'
import { countLabels, LabelFileError } from './labels.js'
import { createLogger } from './logger.js'
import { createRoutes } from './routes.js'
import { createServer } from './server.js'
import { LabelStore } from './store.js'

async function main(): Promise<void> {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error
  })

  let settings: DelegateSettings
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

  const logger = createLogger({ level: settings.logLevel, base: { component: 'delegate' } })

  let store: LabelStore
  try {
    store = await LabelStore.open({
      path: settings.labelsPath,
      fallbackTtl: settings.defaultTtl,
      reloadSec: settings.reloadSec,
      logger,
    })
  } catch (error) {
    const where = error instanceof LabelFileError && error.key !== null ? ` (${error.key})` : ''
    process.stderr.write(`labels: ${settings.labelsPath}${where}: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
    return
  }

  const file = store.current()
  // Presence, not equality: a host serving customers should not have to
  // restate its whole roster in `.env`. What this catches is the file that
  // belongs to a different deployment, before it answers with another owner's
  // addresses.
  const missing = settings.names.filter((name) => !file.names.has(name))
  if (missing.length > 0) {
    process.stderr.write(
      `labels: NNS_DELEGATE_NAME lists ${missing.join(', ')}, which ${settings.labelsPath} does not answer for\n`,
    )
    process.exitCode = 2
    return
  }

  store.start()
  const server = createServer(createRoutes(store), logger)

  server.listen(settings.port, settings.host, () => {
    logger.info('delegate.start', {
      host: settings.host,
      port: settings.port,
      names: [...file.names.keys()].join(','),
      labels: countLabels(file),
      path: settings.labelsPath,
    })
  })

  // Reload on demand, for an owner who does not want to wait out the poll.
  process.on('SIGHUP', () => {
    void store.reload()
  })

  const shutdown = (): void => {
    logger.info('delegate.stop')
    store.stop()
    server.close()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exitCode = 1
})
