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
  UsageError,
  formatLuna,
  hours,
  noticeInWords,
  readBalance,
  type AdminRpc,
} from './cli.js'
import type { ActiveParams, ParamsSource } from './params.js'

/**
 * Margin this CLI demands *above* `GOVERNANCE_DELAY`, in blocks (~1 h).
 *
 * Notice is the one §10.6 bound that cannot be checked exactly: the reducer
 * measures it from the block the message *lands in*, and this process only
 * knows the head it planned against. An `effective_height` at exactly
 * `head + GOVERNANCE_DELAY` therefore forfeits unless the message is mined in
 * the very next block — the mempool decides, and it is unretractable either
 * way. §6 `P` says clients MUST compute it "with margin above
 * `GOVERNANCE_DELAY`, never from the exact minimum"; this is that margin, and
 * it is a client policy rather than a protocol rule, which is why it lives
 * here and not in `core`.
 */
export const NOTICE_MARGIN = 3_600

/**
 * How far behind the node the API may be before the plan says so, in blocks
 * (~17 min). Under §7.2 step 3 the indexer trails the chain by finality, so a
 * small lag is normal; a large one means the relative bounds were checked
 * against a state the chain has since moved past.
 */
export const PARAMS_LAG_LIMIT = 1_000

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

/**
 * `refuse` blocks the broadcast: the message would be forfeited, or would
 * never be mined. `warn` is printed and does not.
 */
export type CheckSeverity = 'refuse' | 'warn'

export interface GovernanceCheck {
  readonly severity: CheckSeverity
  readonly message: string
}

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

  // §10.6 frequency. Measured at inclusion, which is at or after the head this
  // was planned against — so a `P` that clears the interval now still clears
  // it when mined, and one that does not may clear it later.
  if (active.lastGovernanceHeight !== null) {
    const since = head - active.lastGovernanceHeight
    if (since < CONSTANTS.PRICE_MIN_INTERVAL) {
      const wait = CONSTANTS.PRICE_MIN_INTERVAL - since
      refuse(
        `§10.6 frequency: the last accepted P was at height ${active.lastGovernanceHeight}, ${since} blocks ago; ` +
          `PRICE_MIN_INTERVAL is ${CONSTANTS.PRICE_MIN_INTERVAL} blocks, so this forfeits TOO_SOON — ` +
          `wait ${wait} more blocks (${hours(wait)})`,
      )
    }
  }

  // §6 `P` notice, plus the margin the mempool makes necessary.
  const notice = params.effectiveHeight - head
  if (notice < CONSTANTS.GOVERNANCE_DELAY) {
    refuse(
      `§6 P notice: effective height is ${notice} blocks from head ${head}, under GOVERNANCE_DELAY ` +
        `(${CONSTANTS.GOVERNANCE_DELAY} blocks, ${hours(CONSTANTS.GOVERNANCE_DELAY)}) — ` +
        'this forfeits INSUFFICIENT_NOTICE even if it is mined in the next block',
    )
  } else if (notice < CONSTANTS.GOVERNANCE_DELAY + NOTICE_MARGIN) {
    refuse(
      `§6 P notice: effective height is ${notice} blocks from head ${head}, which clears GOVERNANCE_DELAY by ` +
        `${notice - CONSTANTS.GOVERNANCE_DELAY} blocks. Notice is measured from the block this lands in, not from ` +
        `now, so it forfeits if it waits longer than that in the mempool — use at least ` +
        `${head + CONSTANTS.GOVERNANCE_DELAY + NOTICE_MARGIN} (${hours(NOTICE_MARGIN)} of margin)`,
    )
  }

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
        'a P accepted since is not reflected in the prices or in the frequency check',
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
