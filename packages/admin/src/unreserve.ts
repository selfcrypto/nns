/**
 * `U` — Unreserve (§6, r17): release a reserved name, or award it.
 *
 * The contract is `encodeUnreserve`'s, not restated here: an omitted (or
 * null) recipient releases the name — the transaction goes to
 * `PROTOCOL_ADDRESS` — while an address awards it, and `BURN_ADDRESS` is
 * refused because the reducer would forfeit the message (`INVALID_RECIPIENT`,
 * §7.4). This module only parses argv, hands the operand to the builder, and
 * broadcasts what it built. If a rule seems to be missing here, it lives in
 * `core` — do not add it here.
 *
 * **Dry-run by default.** A governance message cannot be retracted once it is
 * in a block, so the command always builds and describes the plan, and
 * broadcasts nothing without an explicit `--send`.
 */

import { CONSTANTS, encodeUnreserve, formatAddress, parseAddress, type Address, type NnsConfig } from '@nns/core'

import { UsageError, noticeInWords, type AdminRpc } from './cli.js'

export interface UnreserveParams {
  readonly name: string
  readonly effectiveHeight: number
  /** `null` releases the name; an address awards it (r17). */
  readonly recipient: Address | null
}

export interface UnreserveCommand {
  readonly params: UnreserveParams
  /** Dry-run unless the caller passed `--send`. */
  readonly send: boolean
}

/** What one `U` would do, priced against the current head. */
export interface UnreservePlan {
  readonly params: UnreserveParams
  readonly kind: 'release' | 'award'
  /** Where the transaction goes: `PROTOCOL_ADDRESS` or the awardee. */
  readonly recipient: Address
  readonly data: string
  readonly value: bigint
  /** Chain head at planning time; doubles as the broadcast's `validityStartHeight`. */
  readonly head: number
}

export interface UnreserveOutcome {
  readonly kind: 'release' | 'award'
  readonly recipient: Address
  readonly validityStartHeight: number
  readonly hash: string
}

/** `u <name> <effective-height> [recipient] [--send]` — omit the recipient to release. */
export function parseUnreserveArgs(argv: readonly string[]): UnreserveCommand {
  const flags = argv.filter((arg) => arg.startsWith('-'))
  for (const flag of flags) {
    if (flag !== '--send') throw new UsageError(`unknown flag ${JSON.stringify(flag)} — the only flag is --send`)
  }
  const [name, height, recipient, ...rest] = argv.filter((arg) => !arg.startsWith('-'))
  if (name === undefined || height === undefined || rest.length > 0) {
    throw new UsageError('u takes a name, an effective height, and optionally an awardee address')
  }
  if (!/^\d+$/.test(height) || !Number.isSafeInteger(Number(height))) {
    throw new UsageError(`effective-height must be a non-negative integer, got ${JSON.stringify(height)}`)
  }
  return {
    params: {
      name,
      effectiveHeight: Number(height),
      recipient: recipient === undefined ? null : parseAddress(recipient),
    },
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
  const tx = encodeUnreserve(config, { ...params, sender: config.admin })
  const head = await rpc.call<number>('getBlockNumber')
  return {
    params,
    kind: params.recipient === null ? 'release' : 'award',
    recipient: tx.recipient,
    data: tx.data,
    value: tx.value,
    head,
  }
}

/** The plan as lines for a human to read *before* deciding to `--send`. */
export function describePlan(plan: UnreservePlan): string[] {
  const { params, kind, recipient, head } = plan
  const notice = params.effectiveHeight - head
  const when = noticeInWords(params.effectiveHeight, head)
  const lines = [
    `U ${kind}: ${params.name}`,
    kind === 'release'
      ? `  to        ${formatAddress(recipient)} (PROTOCOL_ADDRESS — the name becomes AVAILABLE)`
      : `  to        ${formatAddress(recipient)} (awarded the name, full term, no fee)`,
    `  effective at height ${params.effectiveHeight} — head is ${head}, so ${when}`,
  ]
  if (notice < CONSTANTS.GOVERNANCE_DELAY) {
    lines.push(
      `  WARNING: notice is under GOVERNANCE_DELAY (${CONSTANTS.GOVERNANCE_DELAY} blocks, ~12 h) — ` +
        'the reducer will forfeit INSUFFICIENT_NOTICE (§6 U)',
    )
  }
  return lines
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
  await rpc.call('unlockAccount', [config.admin, null, null])
  const hash = await rpc.call<string>('sendBasicTransactionWithData', [
    config.admin,
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
