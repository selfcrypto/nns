/**
 * `watch` — print what the log says is owed, and keep printing it.
 *
 * Deliverable 1 of `tasks/04`. It holds **no key and opens no database**, so it
 * can be left running against any operator's API by anyone, including someone
 * checking on the operator. The issuer is the next deliverable; until it exists
 * this binary is the whole service, and running it is how the due set gets
 * looked at before anything is ever paid from it.
 *
 * Exit codes: 0 clean stop, 1 the log is not a safe basis for payment, 2 usage
 * or environment.
 */

import { initialState } from '@nns/core'

import { loadWatcherSettings } from './env.js'
import { httpFetcher } from './source.js'
import { createWatcher, describeSnapshot } from './watch.js'

const USAGE = `usage: watch [--once] [--interval=<seconds>]

Polls NNS_API_URL for new checkpoints, fetches and verifies the §8.2 log at
each one, replays it through @nns/core, and prints every obligation still
outstanding. Holds no key, opens no database, broadcasts nothing.

--once                 take one snapshot and exit.
--interval=<seconds>   override NNS_SETTLEMENT_POLL_SECONDS.

Settings come from the environment; see packages/settlement/.env.example.`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function run(argv: readonly string[]): Promise<number> {
  let once = false
  let interval: number | null = null
  for (const argument of argv) {
    if (argument === '--once') once = true
    else if (argument.startsWith('--interval=')) {
      const value = Number(argument.slice('--interval='.length))
      if (!Number.isInteger(value) || value < 1) {
        console.error(`--interval must be a whole number of seconds >= 1, got ${JSON.stringify(argument)}`)
        return 2
      }
      interval = value
    } else {
      console.error(`unknown argument: ${argument}`)
      console.error(USAGE)
      return 2
    }
  }

  const settings = loadWatcherSettings()
  const watcher = createWatcher({
    apiUrl: settings.apiUrl,
    config: settings.config,
    fetcher: httpFetcher,
    initial: initialState(),
  })
  const pollSeconds = interval ?? settings.pollSeconds

  // Which API, and whether this process can spend — a watcher and an issuer
  // will look identical in a log otherwise, and only one of them holds a key.
  console.log(
    `watching ${settings.apiUrl}${once ? '' : ` every ${pollSeconds}s`} — no key, no database, nothing is broadcast.`,
  )

  // A refusal is fatal, not a retry: every one of them means the served log is
  // not something to pay from, and a watcher that backs off and tries again
  // turns a divergence into a quiet retry loop.
  for (;;) {
    const result = await watcher.poll()
    if (result.kind === 'no-checkpoint') {
      console.log(`${settings.apiUrl} has no checkpoint yet — nothing can be owed before the first boundary.`)
    } else if (result.kind === 'unchanged') {
      console.log(`checkpoint ${result.checkpointHeight} unchanged.`)
    } else {
      for (const line of describeSnapshot(result.snapshot)) console.log(line)
    }
    if (once) return 0
    console.log(`(next poll in ${pollSeconds}s)`)
    await sleep(pollSeconds * 1000)
  }
}

try {
  process.exitCode = await run(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = error instanceof Error && error.name === 'EnvError' ? 2 : 1
}
