/**
 * `u --batch <file>` — a list of awards, as one plan.
 *
 * The re-award after a repricing rebuild is a list (`tasks/19` D5: every name
 * the fold repriced is AVAILABLE after the rebuild and goes back to its old
 * owner by one `U` each), and so is a giveaway. Typing them one at a time
 * through the prompt is the wrong shape for a list whose whole point is to
 * go out together, before anyone races the names. So a batch is one file,
 * one dry run that prints every row's decoded plan, and one `--send` that
 * broadcasts them in file order.
 *
 * Awards only. A release is one name, has nothing to do with a list, and
 * keeps the one-at-a-time road with its typed-back confirmation.
 *
 * **The batch is refused as a whole.** Every row is planned by
 * `planUnreserve` — the same builder, the same `/available` read, the same
 * §11.5 check — and one refusing row refuses the batch: the operator fixes
 * the file rather than watching thirty awards go out around one that
 * forfeits. The balance is checked once against the whole cost, since the
 * per-row check would pass thirty times on a balance that covers one.
 *
 * File format: one award per line, `name recipient [L]` — the recipient as
 * an address is printed, spaces and all; `#` starts a comment and blank lines
 * are skipped. `L` is the lifetime flag, spelled as the payload spells it. A name twice in one file is a usage
 * error: the second award forfeits `NAME_NOT_AVAILABLE` on the first.
 */

import { readFileSync } from 'node:fs'

import { CONSTANTS, formatAddress, parseAddress, type Address } from '@nns/core'

import {
  ADMIN_MIN_BALANCE,
  AdminRefusal,
  UsageError,
  blockingChecks,
  broadcast,
  formatLuna,
  type AdminCheck,
  type AdminRpc,
  type Broadcast,
} from './cli.js'
import type { ReservationSource } from './reservation.js'
import { describePlan, planUnreserve, type UnreserveParams, type UnreservePlan } from './unreserve.js'

export interface BatchCommand {
  readonly file: string
  readonly rows: readonly UnreserveParams[]
  /** Dry-run unless the caller passed `--send`. */
  readonly send: boolean
}

/** Every row's plan, plus the checks that only make sense over the list. */
export interface BatchPlan {
  readonly file: string
  readonly rows: readonly UnreservePlan[]
  readonly sender: Address
  /** Chain head at planning time — every row's `validityStartHeight`. */
  readonly head: number
  readonly balance: bigint
  /** Σ value over the rows — what the sender must cover for all of them. */
  readonly cost: bigint
  /** The rows' checks, each prefixed with its name, plus the batch's own. */
  readonly checks: readonly AdminCheck[]
}

/** `u --batch <file> [--send]`. */
export function parseBatchArgs(argv: readonly string[]): BatchCommand {
  const flags = argv.filter((arg) => arg.startsWith('-'))
  for (const flag of flags) {
    if (flag !== '--send' && flag !== '--batch') {
      throw new UsageError(`unknown flag ${JSON.stringify(flag)} — with --batch the only other flag is --send`)
    }
  }
  const positional = argv.filter((arg) => !arg.startsWith('-'))
  const file = argv[argv.indexOf('--batch') + 1]
  if (file === undefined || file.startsWith('-') || positional.length !== 1) {
    throw new UsageError('u --batch takes one file of `name recipient [L]` rows and nothing else')
  }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (cause) {
    throw new UsageError(`cannot read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  return { file, rows: parseBatchRows(text, file), send: flags.includes('--send') }
}

/** The file's rows, checked for shape and for duplicates; the names are the builder's to validate. */
export function parseBatchRows(text: string, file: string): readonly UnreserveParams[] {
  const rows: UnreserveParams[] = []
  const seen = new Map<string, number>()
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim()
    if (line === '') return
    const at = `${file}:${index + 1}`
    // An address is printed with spaces (`NQ85 FJ4R …`), so the row is the
    // name, then the address as it was pasted, then an optional trailing L.
    const fields = line.split(/\s+/)
    const lifetime = fields.at(-1) === 'L'
    const [name, ...addressFields] = lifetime ? fields.slice(0, -1) : fields
    const recipient = addressFields.join(' ')
    if (name === undefined || recipient === '') {
      throw new UsageError(`${at}: expected \`name recipient [L]\`, got ${JSON.stringify(raw.trim())}`)
    }
    const first = seen.get(name)
    if (first !== undefined) {
      throw new UsageError(
        `${at}: ${JSON.stringify(name)} is already awarded on line ${first} — the second U forfeits NAME_NOT_AVAILABLE on the first`,
      )
    }
    seen.set(name, index + 1)
    let awardee: Address
    try {
      awardee = parseAddress(recipient)
    } catch (cause) {
      throw new UsageError(`${at}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    rows.push({ name, recipient: awardee, lifetime })
  })
  if (rows.length === 0) throw new UsageError(`${file} holds no award rows`)
  return rows
}

/**
 * Plan every row through `planUnreserve`, then the checks only the list can
 * carry. The head and the balance are read once per row by the row planner —
 * a few RPC calls per award, read-only, and the simplest way to keep one
 * planner; the batch reads the first row's head and balance as its own.
 */
export async function planBatch(rpc: AdminRpc, source: ReservationSource, command: BatchCommand): Promise<BatchPlan> {
  const rows: UnreservePlan[] = []
  for (const params of command.rows) rows.push(await planUnreserve(rpc, source, params))
  const first = rows[0]
  if (first === undefined) throw new UsageError(`${command.file} holds no award rows`)
  const cost = rows.reduce((sum, row) => sum + row.value, 0n)
  const checks: AdminCheck[] = []
  for (const row of rows) {
    // Each row's own checks, save the §11.5 pair, which is re-done below over
    // the whole cost — thirty rows each passing on a balance that covers one
    // is the reason the batch checks it once.
    for (const check of row.checks) {
      if (check.message.startsWith('§11.5')) continue
      checks.push({ severity: check.severity, message: `${row.params.name}: ${check.message}` })
    }
  }
  if (first.balance < cost) {
    checks.push({
      severity: 'refuse',
      message:
        `§11.5: sender balance is ${formatLuna(first.balance)}, below the ${formatLuna(cost)} the ${rows.length} awards cost ` +
        'together — the RPC would accept every transaction, return a hash for each, and the last ones would never be mined',
    })
  } else if (first.balance - cost < ADMIN_MIN_BALANCE) {
    checks.push({
      severity: 'warn',
      message: `§11.5: sender balance is ${formatLuna(first.balance)}, under the ${formatLuna(ADMIN_MIN_BALANCE)} floor once these are paid — top it up`,
    })
  }
  return { file: command.file, rows, sender: CONSTANTS.ADMIN_ADDRESS, head: first.head, balance: first.balance, cost, checks }
}

/** Every row's decoded plan, then the batch line. */
export function describeBatchPlan(plan: BatchPlan): string[] {
  const lines: string[] = [`U batch: ${plan.rows.length} awards from ${plan.file}`, '']
  plan.rows.forEach((row, index) => {
    const [head, ...rest] = describePlan(row)
    lines.push(`[${index + 1}/${plan.rows.length}] ${head ?? ''}`)
    // The row's own checks are repeated at the batch level with the name in
    // front, so they are dropped here rather than printed twice.
    lines.push(...rest.filter((line) => !/^ {2}(REFUSED|WARNING):/.test(line)))
    lines.push('')
  })
  const lifetimes = plan.rows.filter((row) => row.params.lifetime).length
  lines.push(
    `  batch     ${plan.rows.length} awards (${lifetimes} lifetime), ${formatLuna(plan.cost)} in dust, from ` +
      `${formatAddress(plan.sender)} (ADMIN_ADDRESS), balance ${formatLuna(plan.balance)}, all at head ${plan.head}`,
    '  IRREVERSIBLE: every award binds in the block it lands in; a refusing row refuses the whole batch.',
    ...plan.checks.map(({ severity, message }) => `  ${severity === 'refuse' ? 'REFUSED' : 'WARNING'}: ${message}`),
  )
  return lines
}

/**
 * The rows, in file order, each through the one `broadcast`. The batch-level
 * refusal is checked first so no row goes out of a batch that was refused;
 * each row re-checks its own on the way, as `broadcast` always does.
 */
export async function broadcastBatch(rpc: AdminRpc, plan: BatchPlan): Promise<readonly Broadcast[]> {
  const blocking = blockingChecks(plan.checks)
  if (blocking.length > 0) {
    // `execute` never reaches here with a refused plan; this is the re-check
    // `broadcast` makes for one plan, made for the list.
    throw new AdminRefusal(
      `refusing to broadcast the batch: ${blocking.length} check${blocking.length === 1 ? '' : 's'} failed — ` +
        blocking.map((check) => check.message).join('; '),
    )
  }
  const sent: Broadcast[] = []
  for (const row of plan.rows) sent.push(await broadcast(rpc, row))
  return sent
}
