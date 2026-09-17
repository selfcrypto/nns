/**
 * Rules-rebuild CLI.
 *
 *   node dist/rebuild-main.js --log-preserving 30
 *
 * Re-derives every verdict, root and derived row from this database's own §8.2
 * log, in one transaction, leaving the `log` rows and the cursor where they
 * are (`rebuild.ts`). The registry stays up: readers hold their snapshot until
 * the commit.
 *
 * **A flag, not an env var** — and the shape is the argument. `NNS_START_MODE`
 * is an env var because it describes a standing property of a deployment that
 * every start must read. This is a one-shot verb an operator runs once per
 * revision, and its one input is a claim that operator is making *now*: that
 * the revision about to be applied leaves the log's membership and fields
 * alone. A claim that persists in a `.env` is a claim nobody re-makes, which
 * is the opposite of what a declaration is for.
 *
 * Under compose this is `nns-vps rebuild <role> --from-log`, which runs it as
 * a one-shot command against the running Postgres (`deploy/vps/nns-vps`).
 */

import { parseArgs } from 'node:util'

import { CONSTANTS } from '@nimiqnames/core'

import { createPool, migrate } from './db.js'
import { EnvError, loadSettings } from './env.js'
import { createLogger } from './logger.js'
import { RebuildError, rebuildFromLog } from './rebuild.js'
import { Store } from './store.js'

const USAGE = `usage: rebuild-main.js --log-preserving <revision>

Replays this database's own §8.2 log through the current reducer.

  --log-preserving <n>  the revision being applied, which must be this build's
                        own (${CONSTANTS.SPEC_REVISION}) and must be declared
                        log-preserving in docs/history/revisions.md. A revision
                        that moves what is logged (§7.5), the canonical order
                        (§5.2) or the attributed sender (§7.2) is not, and needs
                        a rebuild from the chain.
`

async function main(): Promise<void> {
  let declared: string | undefined
  try {
    const { values } = parseArgs({ options: { 'log-preserving': { type: 'string' } } })
    declared = values['log-preserving']
  } catch (error) {
    process.stderr.write(`rebuild: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }
  if (declared === undefined) {
    process.stderr.write(
      'rebuild: refusing without --log-preserving <revision>.\n\n' +
        'A rules rebuild replays the log this database already holds, so it is only correct for a revision\n' +
        'that leaves the log alone. Nothing in the rows says whether this one does — that is a fact about the\n' +
        'revision, and stating it is the guard.\n\n' +
        USAGE,
    )
    process.exitCode = 2
    return
  }
  const revision = Number(declared)
  if (!Number.isInteger(revision) || revision < 1) {
    process.stderr.write(`rebuild: --log-preserving takes a revision number, got ${JSON.stringify(declared)}\n`)
    process.exitCode = 2
    return
  }

  let settings
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

  const logger = createLogger({ level: settings.logLevel, base: { component: 'rebuild' } })
  const pool = createPool(settings.databaseUrl)
  try {
    // The rebuild runs under the new build's rules, so it runs under the new
    // build's schema: a revision that adds a column adds it here, before the
    // replay that fills it.
    await migrate(pool, logger)
    const result = await rebuildFromLog({
      store: new Store(pool, settings.config, logger),
      logger,
      config: settings.config,
      launchHeight: CONSTANTS.LAUNCH_HEIGHT,
      revision,
    })
    process.stdout.write(
      `rebuilt ${result.lines} log lines through ${result.through.toLocaleString()} at revision ${revision}: ` +
        `${result.verdictsRewritten} verdicts moved, ${result.names} names, ` +
        `commitment ${result.commitment ?? '(none)'}\n` +
        (result.checkpoints.firstMoved === null
          ? `no checkpoint moved (${result.checkpoints.total} re-derived identical)\n`
          : `checkpoints moved from height ${result.checkpoints.firstMoved.toLocaleString()} ` +
            `(${result.checkpoints.moved} of ${result.checkpoints.total}) — check it against the last anchored root ` +
            'before anything publishes\n') +
        `the tail resumes at batch ${result.nextBatch}; hybrid's sweep re-derives the range from the chain\n`,
    )
  } finally {
    await pool.end()
  }
}

try {
  await main()
} catch (error) {
  // A refused declaration is a configuration problem — the operator said
  // something about a revision that is not true of this build — and exits like
  // one. Everything else, including a replay that did not reproduce the log,
  // is a failure with rows behind it.
  if (error instanceof RebuildError) {
    process.stderr.write(`rebuild: ${error.message}\n`)
    process.exitCode = 2
  } else {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    process.stderr.write(`rebuild: ${message}\n`)
    process.exitCode = 1
  }
}
