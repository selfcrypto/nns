/**
 * `ledger` — track the log in the ledger, and print what it holds.
 *
 * Deliverable 3 of `tasks/04`. **It still holds no key and broadcasts
 * nothing.** What it does that `watch` cannot is remember: it records every
 * obligation the log has said is owed, confirms one when the log stops saying
 * so, and survives a restart knowing which log it has been paying against.
 *
 * It never pins a transaction. `pin` and `markSent` exist for the issuer
 * (deliverable 2) and no command here calls them, so this binary can be left
 * running beside a human operator paying by hand — and the ledger will confirm
 * those payments too, from the log, exactly as it would confirm its own.
 *
 * Exit codes: 0 clean stop, 1 the log or the ledger is not a safe basis for
 * payment, 2 usage or environment.
 */

import { initialState } from '@nns/core'
import { createLogger } from '@nns/indexer'

import { createPool } from './db.js'
import { loadLedgerSettings } from './env.js'
import { createLedger, describeLedger } from './ledger.js'
import { httpFetcher } from './source.js'
import { createWatcher, describeSnapshot } from './watch.js'

const USAGE = `usage: ledger [--once] [--interval=<seconds>] [--quiet]

Polls NNS_API_URL for new checkpoints, verifies and replays the §8.2 log, and
records what it says is owed in the settlement ledger: new debts inserted,
paid ones confirmed against a stamped checkpoint height, dead transactions
expired. Migrates its own database on startup.

Holds no key and pins nothing — issuing M transactions is deliverable 2.

--once                 apply one snapshot and exit.
--interval=<seconds>   override NNS_SETTLEMENT_POLL_SECONDS.
--quiet                print the ledger only, not the due set.

Settings come from the environment; see packages/settlement/.env.example.`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function run(argv: readonly string[]): Promise<number> {
  let once = false
  let quiet = false
  let interval: number | null = null
  for (const argument of argv) {
    if (argument === '--once') once = true
    else if (argument === '--quiet') quiet = true
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

  const settings = loadLedgerSettings()
  const logger = createLogger({ base: { component: 'ledger' } })
  const pool = createPool(settings.databaseUrl)
  try {
    const ledger = createLedger({ pool, config: settings.config, apiUrl: settings.apiUrl, logger })
    const { migrationsRun, source } = await ledger.initialise()
    const watcher = createWatcher({
      apiUrl: settings.apiUrl,
      config: settings.config,
      fetcher: httpFetcher,
      initial: initialState(settings.config),
    })
    const pollSeconds = interval ?? settings.pollSeconds

    console.log(
      `ledger over ${settings.apiUrl}${once ? '' : ` every ${pollSeconds}s`} — no key, nothing is broadcast, nothing is pinned.`,
    )
    if (migrationsRun.length > 0) console.log(`migrations applied: ${migrationsRun.join(', ')}`)
    console.log(
      source === null
        ? 'this ledger is empty — the first snapshot will be its baseline.'
        : `resuming from checkpoint ${source.checkpointHeight}, log ${source.logHash}.`,
    )

    // Every refusal below — a rewound log, a fork, a debt that was confirmed
    // settled and is outstanding again — means the log is not the one this
    // ledger has been paying against. None of them is retryable, so none is
    // retried.
    for (;;) {
      const result = await watcher.poll()
      if (result.kind === 'no-checkpoint') {
        console.log(`${settings.apiUrl} has no checkpoint yet — nothing can be owed before the first boundary.`)
      } else if (result.kind === 'unchanged') {
        console.log(`checkpoint ${result.checkpointHeight} unchanged.`)
      } else {
        const update = await ledger.applySnapshot(result.snapshot)
        if (!quiet) for (const line of describeSnapshot(result.snapshot)) console.log(line)
        console.log('')
        console.log(
          `applied checkpoint ${update.checkpointHeight}: ${update.inserted.length} new, ` +
            `${update.confirmed.length} confirmed, ${update.expired.length} expired, ${update.standing} standing.`,
        )
        for (const dead of update.expired) {
          console.log(
            `  ${dead.key} attempt ${dead.attemptNo} is dead: ${dead.wasSent ? `broadcast as ${dead.txHash}, ` : 'never known sent, '}` +
              `past its validity window (${dead.expiresAfter}) and still owed. It can never land; the leg is due again.`,
          )
        }
        console.log('')
        for (const line of describeLedger(await ledger.entries(), await ledger.summary())) console.log(line)
      }
      if (once) return 0
      console.log(`(next poll in ${pollSeconds}s)`)
      await sleep(pollSeconds * 1000)
    }
  } finally {
    await pool.end()
  }
}

try {
  process.exitCode = await run(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = error instanceof Error && error.name === 'EnvError' ? 2 : 1
}
