/**
 * `issue` — settle what the log says is owed. **The system's only hot keys.**
 *
 * Deliverable 2 of `tasks/04`, and the first command in this repository that
 * can move money on its own. Everything it pays comes from the ledger, which
 * got it from a verified `/log` at a stamped checkpoint height; everything it
 * signs it pinned first.
 *
 * One cycle is: poll for a new checkpoint → record it in the ledger (new debts
 * in, paid ones confirmed, dead attempts expired) → issue. Recording before
 * issuing is not an optimisation: without it the pass would pay against a
 * ledger that has not yet learnt which of its own transactions landed, and the
 * frontier it settles up to would be older than the one it just verified.
 *
 * **Dry run by default**, like `admin`'s `u` and the anchor publisher's
 * `publish`. A dry run reads the node — head and balances — and prints the
 * transactions `--send` would broadcast, but pins nothing: a pin commits a
 * `validityStartHeight` and is the point of no return, so a rehearsal that
 * pinned would not be one.
 *
 * Exit codes: 0 clean, 1 the log, the ledger or a send is not safe to continue
 * on, 2 usage or environment.
 */

import { initialState } from '@nns/core'
import { createLogger, RpcClient } from '@nns/indexer'

import { createPool } from './db.js'
import { loadIssuerSettings } from './env.js'
import { describeIssue, issueFailed, issuePass, resolveExpiryBlocks, type Wallet } from './issue.js'
import { createNodeWallet, loadHotKeys } from './keys.js'
import { createLedger, describeLedger } from './ledger.js'
import { httpFetcher } from './source.js'
import { createWatcher } from './watch.js'

const USAGE = `usage: issue [--send] [--once] [--interval=<seconds>] [--limit=<n>] [--quiet]

Polls NNS_API_URL for new checkpoints, records what the §8.2 log says is owed
in the settlement ledger, and issues the M transactions that discharge it:
dueForIssue -> build -> pin -> sign -> send -> markSent, in that order.

Dry run by default. It reads the chain head and the sender balances (§11.5)
and prints every transaction it would broadcast, but pins nothing.

--send                 actually sign and broadcast. Requires the hot keys.
--once                 one cycle, then exit.
--interval=<seconds>   override NNS_SETTLEMENT_POLL_SECONDS.
--limit=<n>            broadcast at most n transactions per cycle.
--quiet                print the issuance report only, not the ledger.

A pinned M expires after the node's own transactionValidityWindow, read once at
startup from getPolicyConstants. NNS_SETTLEMENT_EXPIRY_BLOCKS overrides it and
may only be higher: expiring sooner than the chain does pins a replacement while
the first transaction is still valid, which is the double payment.

Settings come from the environment; see packages/settlement/.env.example. The
keys are NNS_SETTLEMENT_MARKETPLACE_KEY and NNS_SETTLEMENT_TREASURY_KEY, and
they belong in the environment only — never in a file in this repository.`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function run(argv: readonly string[]): Promise<number> {
  let send = false
  let once = false
  let quiet = false
  let interval: number | null = null
  let limit: number | undefined
  for (const argument of argv) {
    if (argument === '--send') send = true
    else if (argument === '--once') once = true
    else if (argument === '--quiet') quiet = true
    else if (argument.startsWith('--interval=') || argument.startsWith('--limit=')) {
      const [name] = argument.split('=')
      const value = Number(argument.slice(argument.indexOf('=') + 1))
      if (!Number.isInteger(value) || value < 1) {
        console.error(`${name} must be a whole number >= 1, got ${JSON.stringify(argument)}`)
        return 2
      }
      if (name === '--interval') interval = value
      else limit = value
    } else {
      console.error(`unknown argument: ${argument}`)
      console.error(USAGE)
      return 2
    }
  }

  const settings = loadIssuerSettings()
  const keys = loadHotKeys(process.env)
  if (send && keys.size === 0) {
    console.error(
      '--send needs a key: set NNS_SETTLEMENT_MARKETPLACE_KEY, NNS_SETTLEMENT_TREASURY_KEY, or both.\n' +
        'Without --send this command is a dry run and needs neither.',
    )
    return 2
  }

  const logger = createLogger({ base: { component: 'issue' } })
  const rpc = new RpcClient({
    url: settings.rpcUrl,
    username: settings.rpcUser,
    password: settings.rpcPassword,
    logger,
  })
  const wallet: Wallet | undefined = send ? createNodeWallet(rpc, keys, logger) : undefined

  const pool = createPool(settings.databaseUrl)
  try {
    const ledger = createLedger({ pool, config: settings.config, apiUrl: settings.apiUrl, logger })
    const { migrationsRun, source } = await ledger.initialise()
    const watcher = createWatcher({
      apiUrl: settings.apiUrl,
      config: settings.config,
      fetcher: httpFetcher,
      initial: initialState(),
      rates: settings.rates,
    })
    const pollSeconds = interval ?? settings.pollSeconds
    // Read once, at startup: the window is a chain constant, and re-reading it
    // per cycle would let it change under a plan already pinned against it.
    const expiry = await resolveExpiryBlocks(rpc, settings.expiryBlocks)

    console.log(
      `issue over ${settings.apiUrl} via ${settings.rpcUrl}${once ? '' : ` every ${pollSeconds}s`} — ` +
        (send
          ? `SENDING. ${keys.size} key(s) held: ${[...keys.values()].map((key) => key.role).join(', ')}.`
          : 'dry run; nothing will be pinned, signed or sent.'),
    )
    if (migrationsRun.length > 0) console.log(`migrations applied: ${migrationsRun.join(', ')}`)
    console.log(
      source === null
        ? 'this ledger is empty — the first snapshot will be its baseline.'
        : `resuming from checkpoint ${source.checkpointHeight}, log ${source.logHash}.`,
    )
    console.log(
      `every M expires ${expiry.blocks} blocks after its validityStartHeight ` +
        (expiry.source === 'node'
          ? "(the node's own transactionValidityWindow)"
          : `(NNS_SETTLEMENT_EXPIRY_BLOCKS${expiry.nodeWindow === null ? ', this node has no getPolicyConstants' : `, above the node's ${expiry.nodeWindow}`})`) +
        `, and the §11.5 alert threshold is ${settings.minBalance} luna.`,
    )

    for (;;) {
      const result = await watcher.poll()
      if (result.kind === 'no-checkpoint') {
        console.log(`${settings.apiUrl} has no checkpoint yet — nothing can be owed before the first boundary.`)
      } else if (result.kind === 'unchanged') {
        console.log(`checkpoint ${result.checkpointHeight} unchanged.`)
      } else {
        const update = await ledger.applySnapshot(result.snapshot)
        console.log(
          `applied checkpoint ${update.checkpointHeight}: ${update.inserted.length} new, ` +
            `${update.confirmed.length} confirmed, ${update.expired.length} expired, ${update.standing} standing.`,
        )
      }

      // Issue on every cycle, including one where the checkpoint did not move:
      // a leg left unpaid because its sender was empty becomes payable the
      // moment somebody tops the address up, and waiting ~12 minutes for the
      // next boundary to notice would be an arbitrary delay on someone's money.
      const report = await issuePass({
        rpc,
        ledger,
        config: settings.config,
        wallet,
        feeLuna: settings.feeLuna,
        expiryBlocks: expiry.blocks,
        minBalance: settings.minBalance,
        limit,
        logger,
      })
      console.log('')
      for (const line of describeIssue(report)) console.log(line)

      if (!quiet) {
        console.log('')
        for (const line of describeLedger(await ledger.entries(), await ledger.summary())) console.log(line)
      }

      if (once) return issueFailed(report) ? 1 : 0
      console.log(`(next cycle in ${pollSeconds}s)`)
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
