/**
 * Admin CLI entry point. Four commands:
 *
 *   p <fee_base> <commission_bp> <effective-height> [--send]
 *   u <name> [recipient] [--lifetime] [--send]
 *   u --batch <file> [--send]
 *   f <amount_luna> [--send]
 *   a <name> <starting_price_luna> <end-height> [--send]
 *
 * Dry-run by default: the plan is always printed, and nothing is broadcast
 * without `--send`.
 */

import { RpcClient } from '@nns/indexer'

import { describeAuctionPlan, parseAuctionArgs, planAuction } from './auction.js'
import { createAuctionsSource } from './auctions.js'
import { broadcastBatch, describeBatchPlan, parseBatchArgs, planBatch } from './batch.js'
import { confirmBurn, createBurnSource, describeBurnPlan, parseBurnArgs, planBurn } from './burn.js'
import { blockingChecks, broadcast, UsageError, type AdminRpc, type Broadcast, type SendablePlan } from './cli.js'
import { loadSettings } from './env.js'
import { describeGovernancePlan, parseGovernanceArgs, planGovernance } from './governance.js'
import { createParamsSource } from './params.js'
import { createReservationSource } from './reservation.js'
import { describePlan, parseUnreserveArgs, planUnreserve } from './unreserve.js'

const USAGE = `usage: p <fee_base> <commission_bp> <effective-height> [--send]
       u <name> [recipient] [--lifetime] [--send]
       u --batch <file> [--send]
       f <amount_luna> [--send]
       a <name> <starting_price_luna> <end-height> [--send]

p builds a P (§6): the one governed price — fee_base, the 12+ character yearly
fee, in luna — and the marketplace commission in basis points, in one message,
taking effect at the given height. Every band is a frozen multiple of the base
(§10.1), so the plan prints every band's yearly fee: check those, not the luna.
It checks every §10.6 bound it can before signing, against the prices and the
last P's height read from NNS_API_URL, and refuses to broadcast a message that
would be forfeited on-chain.

u builds a U (§6) and prints what it would do: release the reserved name — the
transaction goes to PROTOCOL_ADDRESS — or, if a recipient address is given,
award it to that address for one term, or with --lifetime for LIFETIME_TERMS
terms. An award reaches any name nobody owns (2026-09-11): reserved or plain
AVAILABLE; a REGISTERED name or one in GRACE forfeits NAME_NOT_AVAILABLE and is
refused here. BURN_ADDRESS is refused.

u --batch <file> awards a list — one \`name recipient [L]\` per line, # for a
comment — as one plan: every row's decoded plan is printed, a refusing row
refuses the whole batch, and --send broadcasts them in file order. It is the
re-award after a rebuild, and a giveaway; a release is one name, by hand.

u takes NO effective height. A U executes in the block it lands in (§6 U,
r22): there is no notice window, nothing to cancel, and no second chance. The
dry run below is the only point at which a mistyped name or awardee can be
caught, so read the decoded payload before passing --send.

u REFUSES a release of a name that is not currently reserved, reading GET
/available/{name} from NNS_API_URL: a U for a name that is registered, in
grace, already released, or never on the list is mined and forfeited as
NAME_NOT_RESERVED. An award is refused only for a name somebody holds.

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

a builds an A (§6, r28): the admin's auction of a name still held in
RESERVED_NAMES — a starting price in luna (at least MIN_PRICE as in effect, read from
GET /params) and the height the window ends at. At the close the standing bid
wins: the name is REGISTERED to the bidder for a full term, leaves the reserved
set, and both legs of the sale land on TREASURY_ADDRESS. It REFUSES a name
that is not currently reserved (GET /available/{name} — a released or
registered name forfeits NAME_NOT_FOUND or NOT_OWNER), a name already under
auction (GET /auctions — a second A forfeits AUCTION_OPEN), an end under
AUCTION_MIN_DURATION plus the same landing margin p applies to notice, and
an end over AUCTION_MAX_DURATION (AUCTION_TOO_LONG, r31 fold). K
cannot cancel an auction, so the decoded dry run is the last point to stop it.

All are dry runs; nothing is broadcast without --send.

Settings come from the environment; see packages/admin/.env.example.`

async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command !== 'p' && command !== 'u' && command !== 'f' && command !== 'a') {
    console.error(USAGE)
    return 2
  }
  try {
    if (command === 'p') return await runGovernance(rest)
    if (command === 'u') return await runUnreserve(rest)
    if (command === 'a') return await runAuction(rest)
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

/** What differs between the four commands, once the loop around them is shared. */
interface Command<Plan extends Pick<SendablePlan, 'checks'>> {
  /** Why this command cannot run without `NNS_API_URL` — the usage error names the read. */
  readonly apiReason: string
  readonly plan: (rpc: AdminRpc, apiUrl: string) => Promise<Plan>
  readonly describe: (plan: Plan) => readonly string[]
  /** Appended to the refusal line: what a landed mistake would have cost. */
  readonly refusalNote: string
  /** After a `--send`, with the first hash in hand; its return is the exit code. */
  readonly afterSend?: (sent: Broadcast, apiUrl: string) => Promise<number>
  /** The send: {@link one} for a single message, the batch's own for a list. */
  readonly broadcast: (rpc: AdminRpc, plan: Plan) => Promise<readonly Broadcast[]>
}

/** The one `broadcast`, as a list of one — what every single-message command sends with. */
const one = async (rpc: AdminRpc, plan: SendablePlan): Promise<readonly Broadcast[]> => [await broadcast(rpc, plan)]

/**
 * The loop every command runs: settings, the API demanded on entry, plan,
 * print, refuse or dry-run or send. One copy since 2026-09-02; there were
 * three, and they differed only in the strings this table carries. `a`
 * joined the same day as the fourth row.
 */
async function execute<Plan extends Pick<SendablePlan, 'checks'>>(send: boolean, command: Command<Plan>): Promise<number> {
  const settings = loadSettings()
  if (settings.apiUrl === undefined) {
    throw new UsageError(`${command.apiReason} — see packages/admin/.env.example`)
  }
  const rpc = new RpcClient({ url: settings.rpcUrl, username: settings.rpcUser, password: settings.rpcPassword })
  const plan = await command.plan(rpc, settings.apiUrl)
  for (const line of command.describe(plan)) console.log(line)
  const blocking = blockingChecks(plan.checks)
  if (blocking.length > 0) {
    console.error(
      `refusing: ${blocking.length} check${blocking.length === 1 ? '' : 's'} failed — nothing was sent` +
        `${command.refusalNote}.`,
    )
    return 1
  }
  if (!send) {
    console.log('dry run — nothing was sent. Pass --send to broadcast.')
    return 0
  }
  const sent = await command.broadcast(rpc, plan)
  for (const each of sent) console.log(`sent: tx ${each.hash} (validityStartHeight ${each.validityStartHeight})`)
  const first = sent[0]
  return command.afterSend === undefined || first === undefined ? 0 : await command.afterSend(first, settings.apiUrl)
}

function runGovernance(argv: readonly string[]): Promise<number> {
  const { params, send } = parseGovernanceArgs(argv)
  return execute(send, {
    apiReason:
      'p needs NNS_API_URL: §10.6 bounds the prices relative to the ones in effect and to the last accepted P, ' +
      'which only the API can answer',
    plan: (rpc, apiUrl) => planGovernance(rpc, createParamsSource(apiUrl), params),
    describe: describeGovernancePlan,
    refusalNote: ', and a P that lands cannot be retracted',
    broadcast: one,
  })
}

function runUnreserve(argv: readonly string[]): Promise<number> {
  if (argv.includes('--batch')) return runBatch(argv)
  const { params, send } = parseUnreserveArgs(argv)
  // Two refusals reach the loop: §11.5's balance (added with `f`, 2026-08-17)
  // and the reservation (2026-08-21, after `u nimiq` forfeited). r22 removed
  // the notice, and everything else client-preventable — a bad name,
  // `BURN_ADDRESS`, a self-award — throws inside the builder, in
  // `planUnreserve`, before the node hears anything. Past that, what remains
  // is the printed plan and the explicit `--send`, which §6 `U` names as the
  // whole of the fat-finger protection.
  return execute(send, {
    apiReason:
      'u needs NNS_API_URL: whether the name is still RESERVED is chain state (§6 U forfeits NAME_NOT_RESERVED ' +
      'otherwise), and GET /available/{name} is the only thing that answers it',
    plan: (rpc, apiUrl) => planUnreserve(rpc, createReservationSource(apiUrl), params),
    describe: describePlan,
    refusalNote: '',
    broadcast: one,
  })
}

function runBatch(argv: readonly string[]): Promise<number> {
  const command = parseBatchArgs(argv)
  // The same reads as `u`, once per row, and one plan whose checks are every
  // row's plus the balance over the whole list. A refusing row refuses the
  // batch: the file is fixed, not the order of the sends.
  return execute(command.send, {
    apiReason:
      'u needs NNS_API_URL: whether each name is held is chain state (§6 U forfeits NAME_NOT_AVAILABLE on an award ' +
      'of a held name), and GET /available/{name} is the only thing that answers it',
    plan: (rpc, apiUrl) => planBatch(rpc, createReservationSource(apiUrl), command),
    describe: describeBatchPlan,
    refusalNote: ' — fix the file; a batch goes out whole or not at all',
    broadcast: broadcastBatch,
  })
}

function runAuction(argv: readonly string[]): Promise<number> {
  const { params, send } = parseAuctionArgs(argv)
  // Three reads, all chain state the message cannot speak for: MIN_PRICE as
  // in effect (the starting price's floor, and the builder's argument), whether the
  // name is still RESERVED, and whether an auction is already running on it.
  // The floor, a bad name and a self-send throw inside the builder; the rest
  // are refusals the printed plan carries.
  return execute(send, {
    apiReason:
      'a needs NNS_API_URL: MIN_PRICE as in effect (GET /params), whether the name is still RESERVED ' +
      '(GET /available/{name}) and whether it is already under auction (GET /auctions) are chain state, and an A ' +
      'that gets any of them wrong is mined and forfeited',
    plan: (rpc, apiUrl) =>
      planAuction(
        rpc,
        {
          params: createParamsSource(apiUrl),
          reservation: createReservationSource(apiUrl),
          auctions: createAuctionsSource(apiUrl),
        },
        params,
      ),
    describe: describeAuctionPlan,
    refusalNote: ', and an A that lands cannot be cancelled',
    broadcast: one,
  })
}

function runBurn(argv: readonly string[]): Promise<number> {
  const { params, send } = parseBurnArgs(argv)
  return execute(send, {
    apiReason:
      'f needs NNS_API_URL: the §10.2 ceiling (owed − burned) comes from GET /burn, and a burn without a ceiling ' +
      'is a burn nothing checks',
    plan: (rpc, apiUrl) => planBurn(rpc, createBurnSource(apiUrl), params),
    describe: describeBurnPlan,
    refusalNote: ', and BURN_ADDRESS gives nothing back',
    broadcast: one,
    afterSend: async (sent, apiUrl) => {
      // §5.3: a returned hash is not confirmation — three silent drop routes.
      // Confirm by effect at the API, or say plainly that nothing confirmed it.
      console.log('confirming by effect: polling /burn for this attestation…')
      // The source's fetch is failure-tolerant by its contract: this runs
      // after the money has left, and a transient error must read as "not
      // seen yet", never abort the poll into a stack trace.
      const confirmed = await confirmBurn(() => createBurnSource(apiUrl).fetchAttestations(), sent.hash)
      if (confirmed) {
        console.log(`confirmed: the attestation is in the log (tx ${sent.hash})`)
        return 0
      }
      // The transaction may still sit unmined in the mempool, where neither
      // /burn nor the node sweep can see it — the sweep reads *executed*
      // transactions only, and a rerun plans against a new head, so a second f
      // is a NEW transaction, not a re-broadcast of this one. Both can mine.
      console.error(
        `UNCONFIRMED: tx ${sent.hash} was accepted by the RPC and has not appeared in /burn. That hash is not ` +
          'confirmation (§5.3) — and this is not a failure report either: the transaction may be unmined in the ' +
          'mempool, invisible to /burn and to the node sweep alike. DO NOT rerun f yet — a rerun is a new ' +
          'transaction against a new head, and both can mine. Check the hash at the node (getTransactionByHash) ' +
          'and /burn; rerun only once this transaction is in the log, or provably expired past its validity window.',
      )
      return 1
    },
  })
}

process.exitCode = await run(process.argv.slice(2))
