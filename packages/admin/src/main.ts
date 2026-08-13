/**
 * Admin CLI entry point. One command so far:
 *
 *   u <name> <effective-height> [recipient] [--send]
 *
 * Omit the recipient to release the reserved name; give an address to award
 * it (r17). Dry-run by default: the plan is always printed, and nothing is
 * broadcast without `--send`. `P` and `F` are not implemented yet.
 */

import { RpcClient } from '@nns/indexer'

import { loadSettings } from './env.js'
import { UsageError, broadcastUnreserve, describePlan, parseUnreserveArgs, planUnreserve } from './unreserve.js'

const USAGE = `usage: u <name> <effective-height> [recipient] [--send]

Builds a U (§6) and prints what it would do: release the reserved name — the
transaction goes to PROTOCOL_ADDRESS — or, if a recipient address is given,
award it to that address at the effective height (r17). BURN_ADDRESS is
refused. Dry-run by default; nothing is broadcast without --send.
P and F are not implemented yet.

Settings come from the environment; see packages/admin/.env.example.`

async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command !== 'u') {
    console.error(USAGE)
    return 2
  }
  try {
    const { params, send } = parseUnreserveArgs(rest)
    const settings = loadSettings()
    const rpc = new RpcClient({
      url: settings.rpcUrl,
      username: settings.rpcUser,
      password: settings.rpcPassword,
    })
    const plan = await planUnreserve(rpc, settings.config, params)
    for (const line of describePlan(plan)) console.log(line)
    if (!send) {
      console.log('dry run — nothing was sent. Pass --send to broadcast.')
      return 0
    }
    const outcome = await broadcastUnreserve(rpc, settings.config, plan)
    console.log(`sent: tx ${outcome.hash} (validityStartHeight ${outcome.validityStartHeight})`)
    return 0
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message)
      console.error(USAGE)
      return 2
    }
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    return 1
  }
}

process.exitCode = await run(process.argv.slice(2))
