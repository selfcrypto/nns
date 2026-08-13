/**
 * Admin CLI entry point. One command so far:
 *
 *   u <name> <effective-height> [recipient]
 *
 * Omit the recipient to release the reserved name; give an address to award
 * it (r17). `P` and `F` are not implemented yet.
 */

import { formatAddress } from '@nns/core'
import { RpcClient } from '@nns/indexer'

import { loadSettings } from './env.js'
import { UsageError, parseUnreserveArgs, sendUnreserve } from './unreserve.js'

const USAGE = `usage: u <name> <effective-height> [recipient]

Sends a U (§6): releases the reserved name — the transaction goes to
PROTOCOL_ADDRESS — unless a recipient address is given, in which case the
name is awarded to it at the effective height (r17). BURN_ADDRESS is refused.
P and F are not implemented yet.

Settings come from the environment; see packages/admin/.env.example.`

async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command !== 'u') {
    console.error(USAGE)
    return 2
  }
  try {
    const params = parseUnreserveArgs(rest)
    const settings = loadSettings()
    const rpc = new RpcClient({
      url: settings.rpcUrl,
      username: settings.rpcUser,
      password: settings.rpcPassword,
    })
    const outcome = await sendUnreserve(rpc, settings.config, params)
    const effect =
      outcome.kind === 'release' ? 'released' : `awarded to ${formatAddress(outcome.recipient)}`
    console.log(`U sent: ${params.name} ${effect} at effective height ${params.effectiveHeight}`)
    console.log(`tx ${outcome.hash} (validityStartHeight ${outcome.validityStartHeight})`)
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
