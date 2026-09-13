/**
 * `P` — Governance (§6, §10.6): set `FEE_BASE` and `COMMISSION_RATE` from an
 * effective height. Both travel in one message so they cannot drift out of
 * sync — that is the encoder's contract, not restated here. One fee since
 * 2026-09-11 (§10.1): the bands are `core`'s frozen `FEE_MULTIPLIERS` on top
 * of it, which is why the readback prints every band's yearly fee — a
 * misplaced decimal on the base is a 200× mistake on a two-letter name, and
 * that is the number an operator should be looking at, not the luna.
 *
 * **Dry-run by default**, for the same reason `u` is: a governance message
 * cannot be retracted. It is worse here. A `P` that breaks any §10.6 bound is
 * not rejected by the node — it is accepted, mined, and *forfeited* by every
 * indexer independently, and stays on-chain permanently (§6 `P` records two
 * such messages from 2026-08-13). So every bound that can be checked before
 * signing is checked before signing, and a plan carrying a refusal cannot be
 * broadcast at all.
 *
 * One of those bounds — the commission step — is relative to state this
 * process does not hold (three were, before r20 removed the price rate
 * limits); see `params.ts` for where the current prices come from. The bounds
 * themselves are `core`'s `governanceBoundViolation`; if a rule seems to be
 * missing here, it lives there.
 */

import {
  CONSTANTS,
  encodeGovernance,
  feeFor,
  formatAddress,
  governanceBoundViolation,
  type Address,
  type Prices,
} from '@nimiqnames/core'

import {
  ADMIN_MIN_BALANCE,
  GOVERNANCE_NOTICE,
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
  readonly feeBase: bigint
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

function amount(raw: string | undefined, label: string): bigint {
  if (raw === undefined) throw new UsageError(`p takes ${label}`)
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`${label} must be a whole number of luna (1 NIM = 100,000 luna), got ${JSON.stringify(raw)}`)
  }
  return BigInt(raw)
}

/** `p <fee_base> <commission_bp> <effective-height> [--send]` — luna and basis points. */
export function parseGovernanceArgs(argv: readonly string[]): GovernanceCommand {
  const flags = argv.filter((arg) => arg.startsWith('-'))
  for (const flag of flags) {
    if (flag !== '--send') throw new UsageError(`unknown flag ${JSON.stringify(flag)} — the only flag is --send`)
  }
  const positional = argv.filter((arg) => !arg.startsWith('-'))
  // Four positionals was the shape through 2026-09-10 (`fee_standard`,
  // `fee_long`, commission, height). Catching it by count names the habit
  // instead of reading the old commission as the height and refusing it as
  // too-short notice, two lines later and for the wrong reason.
  if (positional.length === 4) {
    throw new UsageError(
      'p takes ONE fee since 2026-09-11 — fee_base, the 12+ character yearly fee; the bands are frozen multiples of ' +
        'it (§10.1). Got four arguments where fee_base, commission_bp and an effective height were expected.',
    )
  }
  const [feeBase, commissionBp, effectiveHeight, ...rest] = positional
  if (effectiveHeight === undefined || rest.length > 0) {
    throw new UsageError('p takes fee_base, commission_bp and an effective height')
  }
  if (!/^\d+$/.test(effectiveHeight) || !Number.isSafeInteger(Number(effectiveHeight))) {
    throw new UsageError(`effective-height must be a non-negative integer, got ${JSON.stringify(effectiveHeight)}`)
  }
  return {
    params: {
      feeBase: amount(feeBase, 'fee_base (luna)'),
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
  move('fee_base', active.prices.feeBase, params.feeBase)

  // §6 `P` notice, plus the margin the landing block makes necessary. It
  // lives in `cli.ts` from the day it was shared with `u`; since r28 `A`'s
  // window is the other bound of that shape, and the check is one function
  // parameterised by the floor.
  checks.push(...noticeChecks(params.effectiveHeight, head, GOVERNANCE_NOTICE))

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

/**
 * Every band's yearly fee under `prices`, as `<from>–<to> <NIM>` cells —
 * the readback that makes a misplaced decimal visible. Priced by `core`'s
 * `feeFor` on a name of each band's length, never multiplied here, so the
 * line agrees with the reducer by construction.
 */
export function bandFees(prices: Prices): string {
  let from = 1
  return CONSTANTS.FEE_MULTIPLIERS.map((band, index, rows) => {
    const last = index === rows.length - 1
    const label = last ? `${from}+` : band.upTo === from ? `${from}` : `${from}–${band.upTo}`
    from = band.upTo + 1
    return `${label} ${nim(feeFor('x'.repeat(band.upTo), prices))}`
  }).join(' · ')
}

/** Whole NIM with a thousands separator — the unit a band is judged in. */
function nim(luna: bigint): string {
  const whole = luna / 100_000n
  const rest = luna % 100_000n
  const text = whole.toLocaleString('en-US')
  return rest === 0n ? `${text} NIM` : `${text}.${rest.toString().padStart(5, '0').replace(/0+$/, '')} NIM`
}

/** The plan as lines for a human to read *before* deciding to `--send`. */
export function describeGovernancePlan(plan: GovernancePlan): string[] {
  const { params, active, head } = plan
  const change = (label: string, from: bigint, to: bigint, format: (value: bigint) => string): string =>
    `  ${label.padEnd(14)}${from === to ? `${format(to)} (unchanged)` : `${format(from)} → ${format(to)}`}`
  const bp = (value: bigint): string => `${value} bp`
  const proposed: Prices = { feeBase: params.feeBase, commissionBp: params.commissionBp }

  const lines = [
    'P governance:',
    change('fee_base', active.prices.feeBase, params.feeBase, formatLuna),
    // The number a person checks: what each length costs a year under the
    // proposed base. The multipliers are frozen (§10.1), so this is the whole
    // of what the message reprices.
    params.feeBase === active.prices.feeBase
      ? `  yearly fees   ${bandFees(proposed)} (unchanged)`
      : `  yearly fees   ${bandFees(active.prices)}\n              → ${bandFees(proposed)}`,
    change('commission', active.prices.commissionBp, params.commissionBp, bp),
    `  effective at height ${params.effectiveHeight} — head is ${head}, so ${noticeInWords(params.effectiveHeight, head)}`,
    `  earliest usable ${head + CONSTANTS.GOVERNANCE_DELAY + NOTICE_MARGIN} — GOVERNANCE_DELAY (${CONSTANTS.GOVERNANCE_DELAY}) ` +
      `plus ${NOTICE_MARGIN} blocks (${hours(NOTICE_MARGIN)}) of landing margin, since notice runs from the block this lands in`,
    `  to            ${formatAddress(plan.recipient)} (PROTOCOL_ADDRESS), value ${formatLuna(plan.value)}, fee 0`,
    `  from          ${formatAddress(plan.sender)} (ADMIN_ADDRESS), balance ${formatLuna(plan.balance)}`,
    `  checked against ${active.url} at height ${active.height} (${head - active.height} blocks behind head):`,
    `    active      fee_base ${formatLuna(active.prices.feeBase)}, commission ${bp(active.prices.commissionBp)}`,
    active.lastGovernanceHeight === null
      ? '    last P      none accepted since launch'
      : `    last P      height ${active.lastGovernanceHeight}, ${head - active.lastGovernanceHeight} blocks ago (${hours(head - active.lastGovernanceHeight)})`,
  ]
  if (active.pending !== null) {
    lines.push(
      `    pending     fee_base ${formatLuna(active.pending.prices.feeBase)}, ` +
        `commission ${bp(active.pending.prices.commissionBp)} at height ${active.pending.effectiveHeight}`,
    )
  }
  for (const { severity, message } of plan.checks) {
    lines.push(`  ${severity === 'refuse' ? 'REFUSED' : 'WARNING'}: ${message}`)
  }
  return lines
}
