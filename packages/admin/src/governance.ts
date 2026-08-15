/**
 * `P` — Governance (§6, §10.6): set `FEE_STANDARD`, `FEE_LONG` and
 * `COMMISSION_RATE` from an effective height. All three travel in one message
 * so they cannot drift out of order or out of sync — that is the encoder's
 * contract, not restated here.
 *
 * **Dry-run by default**, for the same reason `u` is: a governance message
 * cannot be retracted. It is worse here. A `P` that breaks any §10.6 bound is
 * not rejected by the node — it is accepted, mined, and *forfeited* by every
 * indexer independently, and stays on-chain permanently (§6 `P` records two
 * such messages from 2026-08-13). So every bound that can be checked before
 * signing is checked before signing, and a plan carrying a refusal cannot be
 * broadcast at all.
 *
 * Three of those bounds are relative to state this process does not hold —
 * see `params.ts` for where the current prices and the last `P`'s height come
 * from. The bounds themselves are `core`'s `governanceBoundViolation`; if a
 * rule seems to be missing here, it lives there.
 */

import {
  CONSTANTS,
  encodeGovernance,
  formatAddress,
  governanceBoundViolation,
  type Address,
  type NnsConfig,
} from '@nns/core'

import {
  ADMIN_MIN_BALANCE,
  AdminRefusal,
  NOTICE_MARGIN,
  UsageError,
  formatLuna,
  hours,
  noticeChecks,
  noticeInWords,
  readBalance,
  type AdminCheck,
  type AdminRpc,
} from './cli.js'
import type { ActiveParams, ParamsSource } from './params.js'

/**
 * How far behind the node the API may be before the plan says so, in blocks
 * (~17 min). Under §7.2 step 3 the indexer trails the chain by finality, so a
 * small lag is normal; a large one means the relative bounds were checked
 * against a state the chain has since moved past.
 */
export const PARAMS_LAG_LIMIT = 1_000

/**
 * Above this factor, a price change is only *warned* about — never refused.
 * Client policy, like {@link NOTICE_MARGIN}, and deliberately not in `core`:
 * §10.6 has no rate limit at all, so this cannot be a rule anybody enforces.
 * It is 2× because that is the move a human is most likely to have meant when
 * they typed one digit too many.
 */
export const LARGE_MOVE_FACTOR = 2n

export interface GovernanceParams {
  readonly feeStandard: bigint
  readonly feeLong: bigint
  readonly commissionBp: bigint
  readonly effectiveHeight: number
}

export interface GovernanceCommand {
  readonly params: GovernanceParams
  /** Dry-run unless the caller passed `--send`. */
  readonly send: boolean
}

/** The shared shape, aliased so `p`'s callers keep their name for it. */
export type GovernanceCheck = AdminCheck

/** What one `P` would do, checked against the current head and the live parameters. */
export interface GovernancePlan {
  readonly params: GovernanceParams
  readonly data: string
  readonly value: bigint
  /** `PROTOCOL_ADDRESS` — where a `P` goes (§6 `P`). */
  readonly recipient: Address
  readonly sender: Address
  /** Chain head at planning time; doubles as the broadcast's `validityStartHeight`. */
  readonly head: number
  /** The state §10.6's relative bounds were measured against. */
  readonly active: ActiveParams
  /** `ADMIN_ADDRESS`'s balance, in luna (§11.5). */
  readonly balance: bigint
  /** `value` + `fee` — what the sender must be able to cover. */
  readonly cost: bigint
  readonly checks: readonly GovernanceCheck[]
}

export interface GovernanceOutcome {
  readonly validityStartHeight: number
  readonly hash: string
}

/** The checks that stop a broadcast. Empty means `--send` adds nothing but the send. */
export function refusals(plan: GovernancePlan): readonly GovernanceCheck[] {
  return plan.checks.filter((check) => check.severity === 'refuse')
}

function amount(raw: string | undefined, label: string): bigint {
  if (raw === undefined) throw new UsageError(`p takes ${label}`)
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`${label} must be a whole number of luna (1 NIM = 100,000 luna), got ${JSON.stringify(raw)}`)
  }
  return BigInt(raw)
}

/** `p <fee_standard> <fee_long> <commission_bp> <effective-height> [--send]` — luna and basis points. */
export function parseGovernanceArgs(argv: readonly string[]): GovernanceCommand {
  const flags = argv.filter((arg) => arg.startsWith('-'))
  for (const flag of flags) {
    if (flag !== '--send') throw new UsageError(`unknown flag ${JSON.stringify(flag)} — the only flag is --send`)
  }
  const [feeStandard, feeLong, commissionBp, effectiveHeight, ...rest] = argv.filter((arg) => !arg.startsWith('-'))
  if (effectiveHeight === undefined || rest.length > 0) {
    throw new UsageError('p takes fee_standard, fee_long, commission_bp and an effective height')
  }
  if (!/^\d+$/.test(effectiveHeight) || !Number.isSafeInteger(Number(effectiveHeight))) {
    throw new UsageError(`effective-height must be a non-negative integer, got ${JSON.stringify(effectiveHeight)}`)
  }
  return {
    params: {
      feeStandard: amount(feeStandard, 'fee_standard (luna)'),
      feeLong: amount(feeLong, 'fee_long (luna)'),
      commissionBp: amount(commissionBp, 'commission_bp (basis points)'),
      effectiveHeight: Number(effectiveHeight),
    },
    send: flags.length > 0,
  }
}

/**
 * Build the transaction, read what the bounds are relative to, and check every
 * one of them. Read-only: `getBlockNumber`, `getAccountByAddress`, and one
 * `GET /params`. The builder runs first, with `sender` supplied, so everything
 * offline-preventable fails before anything is fetched.
 */
export async function planGovernance(
  rpc: AdminRpc,
  source: ParamsSource,
  config: NnsConfig,
  params: GovernanceParams,
): Promise<GovernancePlan> {
  const tx = encodeGovernance({ ...params, sender: CONSTANTS.ADMIN_ADDRESS })
  const head = await rpc.call<number>('getBlockNumber')
  const active = await source.fetchParams()
  const balance = await readBalance(rpc, CONSTANTS.ADMIN_ADDRESS)
  // The fee is 0, as it is for every message this CLI sends (§5.4 accepts it).
  const cost = tx.value
  return {
    params,
    data: tx.data,
    value: tx.value,
    recipient: tx.recipient,
    sender: CONSTANTS.ADMIN_ADDRESS,
    head,
    active,
    balance,
    cost,
    checks: check(params, active, head, balance, cost),
  }
}

function check(
  params: GovernanceParams,
  active: ActiveParams,
  head: number,
  balance: bigint,
  cost: bigint,
): GovernanceCheck[] {
  const checks: GovernanceCheck[] = []
  const refuse = (message: string): number => checks.push({ severity: 'refuse', message })
  const warn = (message: string): number => checks.push({ severity: 'warn', message })

  // §10.6 bounds — core's, on the prices in effect. A violation is a forfeit,
  // and the forfeited message stays on-chain.
  const violation = governanceBoundViolation(active.prices, params)
  if (violation !== null) {
    refuse(
      `§10.6 ${violation.bound}: ${violation.message} — every indexer forfeits this GOVERNANCE_BOUND_VIOLATED, ` +
        'and the message cannot be retracted',
    )
  }

  // A large move is legal and unretractable, so it is warned about rather than
  // refused. This is the only thing left between a misplaced decimal and a
  // repriced registry: §10.6 removed PRICE_MAX_FACTOR precisely because a
  // protocol rate limit cannot both permit real repricing and stop an
  // attacker, which leaves the fat-finger case to the client.
  const move = (label: string, from: bigint, to: bigint): void => {
    if (from === to) return
    const big = to > from * LARGE_MOVE_FACTOR || to * LARGE_MOVE_FACTOR < from
    if (big) {
      warn(
        `${label} moves ${formatLuna(from)} → ${formatLuna(to)}, more than ${LARGE_MOVE_FACTOR}× — legal since ` +
          '§10.6 has no rate limit, and unretractable once mined. Check the decimal point',
      )
    }
  }
  move('fee_standard', active.prices.feeStandard, params.feeStandard)
  move('fee_long', active.prices.feeLong, params.feeLong)

  // §6 `P` notice, plus the margin the landing block makes necessary. Shared
  // with `u` (`cli.ts`): the same bound is measured the same way for both, and
  // two copies of it would eventually disagree.
  checks.push(...noticeChecks('P', params.effectiveHeight, head))

  // §11.5 rule 1 — an unfunded sender fails by silence, not by error.
  if (balance < cost) {
    refuse(
      `§11.5: sender balance is ${formatLuna(balance)}, below the ${formatLuna(cost)} this costs — the RPC would ` +
        'accept the transaction, return a hash, and it would never be mined',
    )
  } else if (balance < ADMIN_MIN_BALANCE) {
    // §11.5 rule 2: alerting at zero alerts after the failure.
    warn(`§11.5: sender balance is ${formatLuna(balance)}, below the ${formatLuna(ADMIN_MIN_BALANCE)} floor — top it up`)
  }

  const lag = head - active.height
  if (lag > PARAMS_LAG_LIMIT) {
    warn(
      `the bounds were checked against ${active.url} at height ${active.height}, ${lag} blocks behind the node — ` +
        'a P accepted since is not reflected in the prices these bounds were checked against',
    )
  }
  return checks
}

/** The plan as lines for a human to read *before* deciding to `--send`. */
export function describeGovernancePlan(plan: GovernancePlan): string[] {
  const { params, active, head } = plan
  const change = (label: string, from: bigint, to: bigint, format: (value: bigint) => string): string =>
    `  ${label.padEnd(14)}${from === to ? `${format(to)} (unchanged)` : `${format(from)} → ${format(to)}`}`
  const bp = (value: bigint): string => `${value} bp`

  const lines = [
    'P governance:',
    change('fee_standard', active.prices.feeStandard, params.feeStandard, formatLuna),
    change('fee_long', active.prices.feeLong, params.feeLong, formatLuna),
    change('commission', active.prices.commissionBp, params.commissionBp, bp),
    `  effective at height ${params.effectiveHeight} — head is ${head}, so ${noticeInWords(params.effectiveHeight, head)}`,
    `  earliest usable ${head + CONSTANTS.GOVERNANCE_DELAY + NOTICE_MARGIN} — GOVERNANCE_DELAY (${CONSTANTS.GOVERNANCE_DELAY}) ` +
      `plus ${NOTICE_MARGIN} blocks (${hours(NOTICE_MARGIN)}) of landing margin, since notice runs from the block this lands in`,
    `  to            ${formatAddress(plan.recipient)} (PROTOCOL_ADDRESS), value ${formatLuna(plan.value)}, fee 0`,
    `  from          ${formatAddress(plan.sender)} (ADMIN_ADDRESS), balance ${formatLuna(plan.balance)}`,
    `  checked against ${active.url} at height ${active.height} (${head - active.height} blocks behind head):`,
    `    active      fee_standard ${formatLuna(active.prices.feeStandard)}, fee_long ${formatLuna(active.prices.feeLong)}, commission ${bp(active.prices.commissionBp)}`,
    active.lastGovernanceHeight === null
      ? '    last P      none accepted since launch'
      : `    last P      height ${active.lastGovernanceHeight}, ${head - active.lastGovernanceHeight} blocks ago (${hours(head - active.lastGovernanceHeight)})`,
  ]
  if (active.pending !== null) {
    lines.push(
      `    pending     fee_standard ${formatLuna(active.pending.prices.feeStandard)}, fee_long ${formatLuna(active.pending.prices.feeLong)}, ` +
        `commission ${bp(active.pending.prices.commissionBp)} at height ${active.pending.effectiveHeight}`,
    )
  }
  for (const { severity, message } of plan.checks) {
    lines.push(`  ${severity === 'refuse' ? 'REFUSED' : 'WARNING'}: ${message}`)
  }
  return lines
}

/**
 * Broadcast a plan. Sequence per `docs/rpc-reference.md` §5.2: unlock the
 * admin account by address — the key stays in the node's wallet — then send,
 * reusing the plan's head as `validityStartHeight`.
 *
 * It refuses a plan carrying a refusal rather than trusting the caller to have
 * looked: this is the only function in the module that can spend, and the
 * message it would send is unretractable.
 */
export async function broadcastGovernance(
  rpc: AdminRpc,
  config: NnsConfig,
  plan: GovernancePlan,
): Promise<GovernanceOutcome> {
  const blocking = refusals(plan)
  if (blocking.length > 0) {
    throw new AdminRefusal(
      `refusing to broadcast: ${blocking.length} check${blocking.length === 1 ? '' : 's'} failed — ` +
        blocking.map((check) => check.message).join('; '),
    )
  }
  await rpc.call('unlockAccount', [CONSTANTS.ADMIN_ADDRESS, null, null])
  const hash = await rpc.call<string>('sendBasicTransactionWithData', [
    CONSTANTS.ADMIN_ADDRESS,
    plan.recipient,
    plan.data,
    // JSON has no bigint; the value is DUST_VALUE by construction, so the
    // conversion cannot lose precision. fee 0 is accepted (§5.4).
    Number(plan.value),
    0,
    plan.head,
  ])
  return { validityStartHeight: plan.head, hash }
}
