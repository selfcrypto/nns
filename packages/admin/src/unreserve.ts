/**
 * `U` — Unreserve (§6): release a reserved name, or award it.
 *
 * The contract is `encodeUnreserve`'s, not restated here: an omitted (or
 * null) recipient releases the name — the transaction goes to
 * `PROTOCOL_ADDRESS` — while an address awards it, and `BURN_ADDRESS` is
 * refused because the reducer would forfeit the message (`INVALID_RECIPIENT`,
 * §7.4). This module only parses argv, hands the operand to the builder, and
 * broadcasts what it built. If a rule seems to be missing here, it lives in
 * `core` — do not add it here.
 *
 * **No notice, and no notice checks, since r22.** A `U` takes effect in the
 * block it lands in; `GOVERNANCE_DELAY` is `P`'s alone. §6 `U` says why: an
 * award has no counterparty to warn, and a release announced a day ahead hands
 * a frontrunner a publicly timed starting gun. `noticeChecks` and
 * `unreserveRefusals` went with the bound.
 *
 * **Which makes the dry run the whole of the fat-finger protection.** It was
 * one of two before — a mistyped name or awardee could at least be seen
 * on-chain for a day, even though nothing could be done about it — and it is
 * the only one now. §6 `U` moves that protection here explicitly. So the plan
 * decodes the payload it actually built rather than echoing the arguments back,
 * and nothing is broadcast without `--send`.
 *
 * **The §11.5 balance precheck landed with `f` (2026-08-17).** `ADMIN_ADDRESS`
 * has no income, and an unfunded send fails by *silence* — the RPC accepts the
 * transaction, returns a hash, and it is never mined. The plan reads the
 * balance, refuses when it cannot cover the dust this costs, and warns under
 * `ADMIN_MIN_BALANCE`, exactly as `p` does.
 */

import {
  CONSTANTS,
  encodeUnreserve,
  formatAddress,
  parse,
  parseAddress,
  type Address,
  type NnsConfig,
} from '@nns/core'

import {
  ADMIN_MIN_BALANCE,
  AdminRefusal,
  blockingChecks,
  UsageError,
  formatLuna,
  readBalance,
  type AdminCheck,
  type AdminRpc,
} from './cli.js'

export interface UnreserveParams {
  readonly name: string
  /** `null` releases the name; an address awards it (r17). */
  readonly recipient: Address | null
}

export interface UnreserveCommand {
  readonly params: UnreserveParams
  /** Dry-run unless the caller passed `--send`. */
  readonly send: boolean
}

/** What one `U` would do, against the current head. */
export interface UnreservePlan {
  readonly params: UnreserveParams
  readonly kind: 'release' | 'award'
  /** Where the transaction goes: `PROTOCOL_ADDRESS` or the awardee. */
  readonly recipient: Address
  readonly data: string
  readonly value: bigint
  /** Chain head at planning time; doubles as the broadcast's `validityStartHeight`. */
  readonly head: number
  /** `ADMIN_ADDRESS`'s balance, in luna (§11.5). */
  readonly balance: bigint
  readonly checks: readonly AdminCheck[]
}

export interface UnreserveOutcome {
  readonly kind: 'release' | 'award'
  readonly recipient: Address
  readonly validityStartHeight: number
  readonly hash: string
}

/** `u <name> [recipient] [--send]` — omit the recipient to release. */
export function parseUnreserveArgs(argv: readonly string[]): UnreserveCommand {
  const flags = argv.filter((arg) => arg.startsWith('-'))
  for (const flag of flags) {
    if (flag !== '--send') throw new UsageError(`unknown flag ${JSON.stringify(flag)} — the only flag is --send`)
  }
  const [name, recipient, ...rest] = argv.filter((arg) => !arg.startsWith('-'))
  if (name === undefined || rest.length > 0) {
    throw new UsageError('u takes a name and optionally an awardee address')
  }
  // An effective height was the second positional through r21. Catching it by
  // shape rather than letting it be read as an address turns a stale habit
  // into a usage error instead of a parse failure two lines later.
  if (recipient !== undefined && /^\d+$/.test(recipient)) {
    throw new UsageError(
      `u no longer takes an effective height — a U takes effect in the block it lands in (§6 U, r22). ` +
        `Got ${JSON.stringify(recipient)} where an awardee address was expected.`,
    )
  }
  return {
    params: { name, recipient: recipient === undefined ? null : parseAddress(recipient) },
    send: flags.length > 0,
  }
}

/**
 * Build the transaction and read the head. Read-only: the single RPC call is
 * `getBlockNumber`. The builder runs first, with `sender` supplied, so
 * everything client-preventable — bad name, `BURN_ADDRESS`, and an award to
 * the admin address itself, which the network would drop as a silent
 * self-transaction — fails before the node hears anything.
 */
export async function planUnreserve(
  rpc: AdminRpc,
  config: NnsConfig,
  params: UnreserveParams,
): Promise<UnreservePlan> {
  const tx = encodeUnreserve({ ...params, sender: CONSTANTS.ADMIN_ADDRESS })
  const head = await rpc.call<number>('getBlockNumber')
  const balance = await readBalance(rpc, CONSTANTS.ADMIN_ADDRESS)

  // §11.5 — an unfunded sender fails by silence, not by error: the RPC
  // accepts the transaction, returns a hash, and it is never mined. The same
  // pair of checks `p` runs, at the same severities.
  const checks: AdminCheck[] = []
  if (balance < tx.value) {
    checks.push({
      severity: 'refuse',
      message:
        `§11.5: sender balance is ${formatLuna(balance)}, below the ${formatLuna(tx.value)} this costs — the RPC ` +
        'would accept the transaction, return a hash, and it would never be mined',
    })
  } else if (balance < ADMIN_MIN_BALANCE) {
    checks.push({
      severity: 'warn',
      message: `§11.5: sender balance is ${formatLuna(balance)}, below the ${formatLuna(ADMIN_MIN_BALANCE)} floor — top it up`,
    })
  }

  return {
    params,
    kind: params.recipient === null ? 'release' : 'award',
    recipient: tx.recipient,
    data: tx.data,
    value: tx.value,
    head,
    balance,
    checks,
  }
}

/**
 * The plan as lines for a human to read *before* deciding to `--send`.
 *
 * The name is read back out of the built payload rather than out of `params`,
 * so what is printed is what will be on the wire. With no notice window left,
 * this readback is the only thing between a typo and a permanently released
 * name.
 */
export function describePlan(plan: UnreservePlan): string[] {
  const decoded = parse(plan.data)
  if (!decoded.ok || decoded.message.type !== 'U') {
    throw new Error(`built a U that does not parse back as one: ${plan.data}`)
  }
  const { kind, recipient, head } = plan
  const name = decoded.message.name
  return [
    `U ${kind}: ${name}`,
    kind === 'release'
      ? `  to        ${formatAddress(recipient)} (PROTOCOL_ADDRESS — the name becomes AVAILABLE)`
      : `  to        ${formatAddress(recipient)} (awarded the name, full term, no fee)`,
    `  payload   ${plan.data} — decoded: name ${JSON.stringify(name)}, no other field`,
    `  effective on landing: head is ${head}, so this binds in the next block that carries it — ` +
      'there is no notice window and nothing to cancel (§6 U, r22)',
    ...(kind === 'award'
      ? [
          `  award term ends <landing height> + ${CONSTANTS.TERM_LENGTH}, so at head that is ` +
            `${head + CONSTANTS.TERM_LENGTH} — the term is half-open, and GRACE begins at the end height (§7.3)`,
        ]
      : []),
    `  from      ${formatAddress(CONSTANTS.ADMIN_ADDRESS)} (ADMIN_ADDRESS), balance ${formatLuna(plan.balance)}`,
    `  IRREVERSIBLE: a U cannot be recalled, and this is the last point it can be stopped.`,
    ...plan.checks.map(({ severity, message }) => `  ${severity === 'refuse' ? 'REFUSED' : 'WARNING'}: ${message}`),
  ]
}

/** Refusals only — what stands between this plan and a broadcast. */
export function unreserveRefusals(plan: UnreservePlan): readonly AdminCheck[] {
  return blockingChecks(plan.checks)
}

/**
 * Broadcast a plan. Sequence per `docs/rpc-reference.md` §5.2: unlock the
 * admin account by address — the key stays in the node's wallet — then send,
 * reusing the plan's head as `validityStartHeight`.
 */
export async function broadcastUnreserve(
  rpc: AdminRpc,
  config: NnsConfig,
  plan: UnreservePlan,
): Promise<UnreserveOutcome> {
  const blocking = unreserveRefusals(plan)
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
  return { kind: plan.kind, recipient: plan.recipient, validityStartHeight: plan.head, hash }
}
