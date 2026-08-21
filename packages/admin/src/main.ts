/**
 * Admin CLI entry point. Three commands:
 *
 *   p <fee_standard> <fee_long> <commission_bp> <effective-height> [--send]
 *   u <name> [recipient] [--send]
 *   f <amount_luna> [--send]
 *
 * Dry-run by default: the plan is always printed, and nothing is broadcast
 * without `--send`.
 */

import { RpcClient } from '@nns/indexer'

import {
  broadcastBurn,
  burnRefusals,
  confirmBurn,
  createBurnSource,
  describeBurnPlan,
  parseBurnArgs,
  planBurn,
} from './burn.js'
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
import { createReservationSource } from './reservation.js'
import {
  broadcastUnreserve,
  describePlan,
  parseUnreserveArgs,
  planUnreserve,
  unreserveRefusals,
} from './unreserve.js'

const USAGE = `usage: p <fee_standard> <fee_long> <commission_bp> <effective-height> [--send]
       u <name> [recipient] [--send]
       f <amount_luna> [--send]

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

u REFUSES a name that is not currently reserved, reading GET /available/{name}
from NNS_API_URL: a U for a name that is registered, in grace, already
released, or never on the list is mined and forfeited as NAME_NOT_RESERVED.

p does refuse an effective height under GOVERNANCE_DELAY plus a landing
margin. Notice is measured from the block the message lands in, not from the
head it was planned against, so the exact minimum forfeits; the plan prints
the earliest height it will accept.

f builds an F (§6): the treasury's burn commitment, value = the amount, sent
from TREASURY_ADDRESS to BURN_ADDRESS — an address with no key, so this is
the most irreversible command here. It reads both halves of §10.2 from
NNS_API_URL's GET /burn and REFUSES an amount over the outstanding owed
(owed − burned), an amount over the treasury balance, and a plan whose
ceiling is provably stale (the node shows an executed F the /burn snapshot
has not counted). After --send it polls /burn until the attestation appears,
and reports UNCONFIRMED honestly if it does not — a hash is not confirmation.

All are dry runs; nothing is broadcast without --send.

Settings come from the environment; see packages/admin/.env.example.`

async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command !== 'p' && command !== 'u' && command !== 'f') {
    console.error(USAGE)
    return 2
  }
  try {
    if (command === 'p') return await runGovernance(rest)
    if (command === 'u') return await runUnreserve(rest)
    return await runBurn(rest)
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
  if (settings.apiUrl === undefined) {
    throw new UsageError(
      'u needs NNS_API_URL: whether the name is still RESERVED is chain state (§6 U forfeits NAME_NOT_RESERVED ' +
        'otherwise), and GET /available/{name} is the only thing that answers it — see packages/admin/.env.example',
    )
  }
  const rpc = rpcFor(settings)
  const plan = await planUnreserve(rpc, createReservationSource(settings.apiUrl), settings.config, params)
  for (const line of describePlan(plan)) console.log(line)
  // The one refusal left is §11.5's (added with `f`, 2026-08-17): r22 removed
  // the notice, and everything else client-preventable — a bad name,
  // `BURN_ADDRESS`, a self-award — throws inside the builder, in
  // `planUnreserve`, before the node hears anything. Past that, what remains
  // is the dry run above and this explicit `--send`, which §6 `U` names as
  // the whole of the fat-finger protection.
  const blocking = unreserveRefusals(plan)
  if (blocking.length > 0) {
    console.error(
      `refusing: ${blocking.length} check${blocking.length === 1 ? '' : 's'} failed — nothing was sent.`,
    )
    return 1
  }
  if (!send) {
    console.log('dry run — nothing was sent. Pass --send to broadcast.')
    return 0
  }
  const outcome = await broadcastUnreserve(rpc, settings.config, plan)
  console.log(`sent: tx ${outcome.hash} (validityStartHeight ${outcome.validityStartHeight})`)
  return 0
}

async function runBurn(argv: readonly string[]): Promise<number> {
  const { params, send } = parseBurnArgs(argv)
  const settings = loadSettings()
  if (settings.apiUrl === undefined) {
    throw new UsageError(
      'f needs NNS_API_URL: the §10.2 ceiling (owed − burned) comes from GET /burn, and a burn without a ceiling ' +
        'is a burn nothing checks — see packages/admin/.env.example',
    )
  }
  const rpc = rpcFor(settings)
  const source = createBurnSource(settings.apiUrl)
  const plan = await planBurn(rpc, source, settings.config, params)
  for (const line of describeBurnPlan(plan)) console.log(line)
  const blocking = burnRefusals(plan)
  if (blocking.length > 0) {
    console.error(
      `refusing: ${blocking.length} check${blocking.length === 1 ? '' : 's'} failed — nothing was sent, and ` +
        'BURN_ADDRESS gives nothing back.',
    )
    return 1
  }
  if (!send) {
    console.log('dry run — nothing was sent. Pass --send to broadcast.')
    return 0
  }
  const outcome = await broadcastBurn(rpc, settings.config, plan)
  console.log(`sent: tx ${outcome.hash} (validityStartHeight ${outcome.validityStartHeight})`)
  // §5.3: a returned hash is not confirmation — three silent drop routes.
  // Confirm by effect at the API, or say plainly that nothing confirmed it.
  console.log('confirming by effect: polling /burn for this attestation…')
  // The source's fetch, not a second copy of it — and failure-tolerant by
  // its contract: this runs after the money has left, and a transient error
  // must read as "not seen yet", never abort the poll into a stack trace.
  const confirmed = await confirmBurn(() => source.fetchAttestations(), outcome.hash)
  if (confirmed) {
    console.log(`confirmed: the attestation is in the log (tx ${outcome.hash})`)
    return 0
  }
  // The transaction may still sit unmined in the mempool, where neither
  // /burn nor the node sweep can see it — the sweep reads *executed*
  // transactions only, and a rerun plans against a new head, so a second f
  // is a NEW transaction, not a re-broadcast of this one. Both can mine.
  console.error(
    `UNCONFIRMED: tx ${outcome.hash} was accepted by the RPC and has not appeared in /burn. That hash is not ` +
      'confirmation (§5.3) — and this is not a failure report either: the transaction may be unmined in the ' +
      'mempool, invisible to /burn and to the node sweep alike. DO NOT rerun f yet — a rerun is a new ' +
      'transaction against a new head, and both can mine. Check the hash at the node (getTransactionByHash) ' +
      'and /burn; rerun only once this transaction is in the log, or provably expired past its validity window.',
  )
  return 1
}

process.exitCode = await run(process.argv.slice(2))
