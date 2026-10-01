/**
 * `release` — see whether the issuer is paused, and let it go on.
 *
 * A guard that did not hold (`guards.ts`) leaves a pause in the ledger, and
 * the issuer signs nothing under one. This is the only way out of it, and it
 * is a person's act on purpose: no restart, no timer and no retry ends a
 * pause.
 *
 * **It holds no key, reads no node and pays nothing.** It closes a row. The
 * issuer, already running, reads the ledger before its next pass and carries
 * on from the same debts under the same `(ref, kind)` keys — a pinned plan is
 * re-sent as pinned, a due leg is pinned once.
 *
 * Releasing is not overriding. Every guard is checked again on the next pass:
 * an address still insolvent pauses again, and so does a leg still unbacked
 * unless it was released with `--approve`.
 *
 * Exit codes: 0 done (or nothing to do), 1 the ledger refused, 2 usage or
 * environment.
 */

import { createLogger } from '@nns/indexer'

import { createPool } from './db.js'
import { loadLedgerSettings } from './env.js'
import { createLedger, type Pause } from './ledger.js'

const USAGE = `usage: release [--note=<why>] [--approve]

With no argument: prints whether the issuer is paused, and the last pauses.

--note=<why>   release the open pause. The note is stored with it.
--approve      with --note: also exempt the leg the pause names from the
               deposit guards, so it is paid. For a leg you have checked by
               hand. Only UNBACKED and DEPOSIT_MISMATCH pauses name a leg.

What a release does next, by reason:
  UNBACKED, DEPOSIT_MISMATCH   checked again; pauses again unless --approve.
  INSOLVENT                    checked again; fund the address first.
  DAILY_CAP                    the 24 h window restarts at the release.

Settings come from the environment; see packages/settlement/.env.example.`

const describe = (pause: Pause): string =>
  `#${pause.id} ${pause.reason}${pause.legKey === null ? '' : ` ${pause.legKey}`} at ${pause.pausedAt.toISOString()}: ${pause.detail}` +
  (pause.releasedAt === null
    ? ''
    : `\n    released ${pause.releasedAt.toISOString()}${pause.approved ? ', leg approved' : ''}: ${pause.releaseNote ?? ''}`)

async function run(argv: readonly string[]): Promise<number> {
  let note: string | null = null
  let approve = false
  for (const argument of argv) {
    if (argument === '--approve') approve = true
    else if (argument.startsWith('--note=')) note = argument.slice('--note='.length).trim()
    else {
      console.error(`unknown argument: ${argument}`)
      console.error(USAGE)
      return 2
    }
  }
  if (note === '' || (approve && note === null)) {
    console.error('a release needs --note=<why>: it is stored with the pause, and it is the record of who let the issuer go on.')
    return 2
  }

  const settings = loadLedgerSettings()
  const pool = createPool(settings.databaseUrl)
  try {
    const ledger = createLedger({
      pool,
      config: settings.config,
      apiUrl: settings.apiUrl,
      logger: createLogger({ base: { component: 'release' } }),
    })
    await ledger.initialise()

    if (note === null) {
      const open = await ledger.openPause()
      console.log(open === null ? 'the issuer is not paused.' : `the issuer is PAUSED and signs nothing:\n  ${describe(open)}`)
      const past = (await ledger.pauses(10)).filter((pause) => pause.releasedAt !== null)
      if (past.length > 0) {
        console.log('')
        console.log('earlier pauses, newest first:')
        for (const pause of past) console.log(`  ${describe(pause)}`)
      }
      return 0
    }

    const released = await ledger.release(note, approve)
    if (released === null) {
      console.log('the issuer is not paused — nothing to release.')
      return 0
    }
    console.log(`released:\n  ${describe(released)}`)
    console.log('the issuer picks this up on its next cycle and checks every guard again.')
    return 0
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
