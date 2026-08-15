/**
 * Admin CLI entry point. Two commands:
 *
 *   p <fee_standard> <fee_long> <commission_bp> <effective-height> [--send]
 *   u <name> [recipient] [--send]
 *
 * Dry-run by default: the plan is always printed, and nothing is broadcast
 * without `--send`. `F` is not implemented yet.
 */

import { RpcClient } from '@nns/indexer'

import { UsageError } from './cli.js'
import { loadSettings } from './env.js'
import {
  broadcastGovernance,
  describeGovernancePlan,
  parseGovernanceArgs,
  planGovernance,
  refusals,
} from './governance.js'
import { createParamsSource } from './params.js'
import {
  broadcastUnreserve,
  describePlan,
  parseUnreserveArgs,
  planUnreserve,
} from './unreserve.js'

const USAGE = `usage: p <fee_standard> <fee_long> <commission_bp> <effective-height> [--send]
       u <name> [recipient] [--send]

p builds a P (§6): the two prices — in luna — and the marketplace commission in
basis points, all in one message, taking effect at the given height. It checks
every §10.6 bound it can before signing, against the prices and the last P's
height read from NNS_API_URL, and refuses to broadcast a message that would be
forfeited on-chain.

u builds a U (§6) and prints what it would do: release the reserved name — the
transaction goes to PROTOCOL_ADDRESS — or, if a recipient address is given,
award it to that address. BURN_ADDRESS is refused.

u takes NO effective height. A U executes in the block it lands in (§6 U,
r22): there is no notice window, nothing to cancel, and no second chance. The
dry run below is the only point at which a mistyped name or awardee can be
caught, so read the decoded payload before passing --send.

p does refuse an effective height under GOVERNANCE_DELAY plus a landing
margin. Notice is measured from the block the message lands in, not from the
head it was planned against, so the exact minimum forfeits; the plan prints
the earliest height it will accept.

Both are dry runs; nothing is broadcast without --send. F is not implemented.

Settings come from the environment; see packages/admin/.env.example.`

async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command !== 'p' && command !== 'u') {
    console.error(USAGE)
    return 2
  }
  try {
    return command === 'p' ? await runGovernance(rest) : await runUnreserve(rest)
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

function rpcFor(settings: ReturnType<typeof loadSettings>): RpcClient {
  return new RpcClient({
    url: settings.rpcUrl,
    username: settings.rpcUser,
    password: settings.rpcPassword,
  })
}

async function runGovernance(argv: readonly string[]): Promise<number> {
  const { params, send } = parseGovernanceArgs(argv)
  const settings = loadSettings()
  if (settings.apiUrl === undefined) {
    throw new UsageError(
      'p needs NNS_API_URL: §10.6 bounds the prices relative to the ones in effect and to the last accepted P, ' +
        'which only the API can answer — see packages/admin/.env.example',
    )
  }
  const rpc = rpcFor(settings)
  const plan = await planGovernance(rpc, createParamsSource(settings.apiUrl), settings.config, params)
  for (const line of describeGovernancePlan(plan)) console.log(line)
  const blocking = refusals(plan)
  if (blocking.length > 0) {
    console.error(
      `refusing: ${blocking.length} check${blocking.length === 1 ? '' : 's'} failed — nothing was sent, and a P that ` +
        'lands cannot be retracted.',
    )
    return 1
  }
  if (!send) {
    console.log('dry run — nothing was sent. Pass --send to broadcast.')
    return 0
  }
  const outcome = await broadcastGovernance(rpc, settings.config, plan)
  console.log(`sent: tx ${outcome.hash} (validityStartHeight ${outcome.validityStartHeight})`)
  return 0
}

async function runUnreserve(argv: readonly string[]): Promise<number> {
  const { params, send } = parseUnreserveArgs(argv)
  const settings = loadSettings()
  const rpc = rpcFor(settings)
  const plan = await planUnreserve(rpc, settings.config, params)
  for (const line of describePlan(plan)) console.log(line)
  // No refusals left to run: r22 removed `U`'s only bound that could be
  // checked from here, the notice (§6 `U`). Everything else client-preventable
  // — a bad name, `BURN_ADDRESS`, a self-award — throws inside the builder, in
  // `planUnreserve`, before the node hears anything. What remains is the dry
  // run above and this explicit `--send`, which §6 `U` now names as the whole
  // of the fat-finger protection.
  if (!send) {
    console.log('dry run — nothing was sent. Pass --send to broadcast.')
    return 0
  }
  const outcome = await broadcastUnreserve(rpc, settings.config, plan)
  console.log(`sent: tx ${outcome.hash} (validityStartHeight ${outcome.validityStartHeight})`)
  return 0
}

process.exitCode = await run(process.argv.slice(2))
