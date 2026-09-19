/**
 * What every admin command shares: the RPC slice it talks through, the two
 * error shapes, and the two computations §6 and §11.5 make identical for all
 * of them — a height read as hours from the head, and a sender's balance.
 *
 * Nothing protocol-shaped lives here. A height in hours is a display rule
 * (Albatross targets one block per second) and a balance precheck is §11.5's
 * operational requirement, not a consensus rule.
 */

import { CONSTANTS, LUNA_PER_NIM, formatAddress, type Address } from '@nimiqnames/core'

/**
 * The slice of the RPC surface these commands touch. `@nns/indexer`'s
 * `RpcClient` satisfies it structurally; tests satisfy it with a recorder.
 */
export interface AdminRpc {
  call<T>(method: string, params?: readonly unknown[]): Promise<T>
}

/** Wrong argv shape — the caller prints usage and exits 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError'
}

/** Anything else this CLI refuses to do, with the reason in the message. */
export class AdminError extends Error {
  override readonly name = 'AdminError'
}

/** A plan that failed a local check, refused before the node hears anything. */
export class AdminRefusal extends Error {
  override readonly name = 'AdminRefusal'
}

/** Albatross targets one block per second — `GOVERNANCE_DELAY`'s 86,400 blocks read as ~24 h. */
export const BLOCKS_PER_HOUR = 3_600

/** `~12.0 h`, unsigned — the caller says which direction it runs in. */
export function hours(blocks: number): string {
  return `~${(Math.abs(blocks) / BLOCKS_PER_HOUR).toFixed(1)} h`
}

/** How a target height reads against the head, in the direction that matters. */
export function noticeInWords(effectiveHeight: number, head: number): string {
  const notice = effectiveHeight - head
  return notice >= 0 ? `${hours(notice)} from now` : `${hours(notice)} in the PAST`
}

/**
 * `refuse` blocks the broadcast: the message would be forfeited, or would
 * never be mined. `warn` is printed and does not.
 */
export type CheckSeverity = 'refuse' | 'warn'

export interface AdminCheck {
  readonly severity: CheckSeverity
  readonly message: string
}

/**
 * The refusals in a plan's checks — the shared half of every command's
 * "plan carrying a refusal cannot be broadcast" rule, kept here so a third
 * severity or a changed meaning of `refuse` is one edit, not three.
 */
export function blockingChecks(checks: readonly AdminCheck[]): readonly AdminCheck[] {
  return checks.filter((check) => check.severity === 'refuse')
}

/**
 * What the send needs from a plan, whichever command built it: the bytes,
 * the two addresses, the head it was planned against, and the checks. Every
 * plan carries more; this is the slice {@link broadcast} reads.
 */
export interface SendablePlan {
  readonly sender: Address
  readonly recipient: Address
  /** Hex, as the RPC takes it. */
  readonly data: string
  readonly value: bigint
  readonly head: number
  readonly checks: readonly AdminCheck[]
}

export interface Broadcast {
  readonly validityStartHeight: number
  readonly hash: string
}

/**
 * The send, once. `p`, `u` and `f` each had a copy until 2026-09-02, alike
 * to the line except for the sender — which the plan already knows.
 *
 * A plan carrying any refusal cannot be broadcast: the message would be
 * forfeited or would never be mined. Then unlock by address (the key lives
 * in the node's wallet, docs/rpc-reference.md §5) and send with the probed
 * parameter order — `[wallet, recipient, dataHex, value, fee,
 * validityStartHeight]`. The fee is 0 for every message here (§5.4 accepts
 * it), and `validityStartHeight` is the head the plan was built against.
 *
 * JSON has no bigint, so `value` crosses as a number. For the dust-valued
 * commands the narrowing cannot lose precision; for `f` the value *is* the
 * burn, and `planBurn` refuses any amount outside safe-integer range before
 * this cast can be reached.
 */
export async function broadcast(rpc: AdminRpc, plan: SendablePlan): Promise<Broadcast> {
  const blocking = blockingChecks(plan.checks)
  if (blocking.length > 0) {
    throw new AdminRefusal(
      `refusing to broadcast: ${blocking.length} check${blocking.length === 1 ? '' : 's'} failed — ` +
        blocking.map((check) => check.message).join('; '),
    )
  }
  await rpc.call('unlockAccount', [plan.sender, null, null])
  const hash = await rpc.call<string>('sendBasicTransactionWithData', [
    plan.sender,
    plan.recipient,
    plan.data,
    Number(plan.value),
    0,
    plan.head,
  ])
  return { validityStartHeight: plan.head, hash }
}

/**
 * Margin this CLI demands *above* a landing-measured floor, in blocks (~1 h).
 *
 * Two messages carry a height the reducer measures from the block they
 * **land in**: `P`'s `effective_height` against `GOVERNANCE_DELAY` (§6 `P`)
 * and, since r28, `A`'s `end_height` against `AUCTION_MIN_DURATION` (§6 `A`,
 * "measured from inclusion like `P`'s notice"). This process only knows the
 * head it planned against, so a height at exactly `head + floor` forfeits
 * unless the message is mined in the very next block. §6 `P` says clients
 * MUST compute it "with margin above `GOVERNANCE_DELAY`, never from the exact
 * minimum"; this is that margin, and the same one serves `A`. It is client
 * policy rather than a protocol rule, which is why it lives here and not in
 * `core`.
 *
 * **One check, parameterised by the floor.** It was `P`'s alone from r22
 * (when `U` lost its height) until r28 gave `A` a window of the same shape;
 * the day it was two copies, `u`'s only warned and broadcast a certain
 * `INSUFFICIENT_NOTICE`, which is the argument for keeping it one.
 *
 * **Why an hour rather than the measured latency.** Three delays stack between
 * reading the head and landing in a block, and the one that is easy to measure
 * is the smallest:
 *
 * 1. *Inclusion latency*, 0–5 blocks in practice. On its own a margin of 60
 *    would be ample.
 * 2. *Mempool residency.* These messages carry `fee: 0` (§5.4 accepts it), so
 *    nothing entitles them to the next block, and the tail is not bounded by
 *    anything this process can observe.
 * 3. *The operator.* The command is a dry run first and a `--send` second, and
 *    the head keeps moving between the two while a human reads the plan and
 *    decides. This is the largest term by far and the only one measured in
 *    minutes rather than blocks.
 *
 * The asymmetry settles the size. An hour of extra notice on a change already
 * a day away costs 4% more delay; a message that lands one block short is
 * forfeited, **unretractable** (§6 `P`), and costs a fresh `GOVERNANCE_DELAY`
 * — 24 h on mainnet — to retry. So round up well past the measurement rather
 * than trimming to it. 3,600 is also exactly {@link BLOCKS_PER_HOUR}, so the
 * output reads as "1 h of margin" rather than as a magic number.
 */
export const NOTICE_MARGIN = BLOCKS_PER_HOUR

/** A height the reducer measures from the landing block, and the floor it must clear. */
export interface LandingBound {
  /** How the plan names the rule — `§6 P notice`, `§6 A window`. */
  readonly clause: string
  /** The height field's name in the operator's words. */
  readonly field: string
  readonly floor: number
  readonly floorName: string
}

/** `P`: `effective_height − landing ≥ GOVERNANCE_DELAY` (§6 `P`, §10.6). */
export const GOVERNANCE_NOTICE: LandingBound = Object.freeze({
  clause: '§6 P notice',
  field: 'effective height',
  floor: CONSTANTS.GOVERNANCE_DELAY,
  floorName: 'GOVERNANCE_DELAY',
})

/** `A`: `end_height − landing ≥ AUCTION_MIN_DURATION` (§6 `A`), forfeiting the same token. */
export const AUCTION_WINDOW: LandingBound = Object.freeze({
  clause: '§6 A window',
  field: 'end height',
  floor: CONSTANTS.AUCTION_MIN_DURATION,
  floorName: 'AUCTION_MIN_DURATION',
})

/**
 * The landing-measured bound. Empty when the target clears the floor with the
 * margin; otherwise one refusal, because both shortfalls forfeit
 * `INSUFFICIENT_NOTICE` and neither can be retracted.
 */
export function noticeChecks(target: number, head: number, bound: LandingBound): AdminCheck[] {
  const notice = target - head
  const { clause, field, floor, floorName } = bound
  if (notice < floor) {
    return [
      {
        severity: 'refuse',
        message:
          `${clause}: ${field} is ${notice} blocks from head ${head}, under ${floorName} ` +
          `(${floor} blocks, ${hours(floor)}) — ` +
          'this forfeits INSUFFICIENT_NOTICE even if it is mined in the next block',
      },
    ]
  }
  if (notice < floor + NOTICE_MARGIN) {
    return [
      {
        severity: 'refuse',
        message:
          `${clause}: ${field} is ${notice} blocks from head ${head}, which clears ` +
          `${floorName} by ${notice - floor} blocks. The window is measured from the block this lands in, not ` +
          `from now, so it forfeits if it waits longer than that between here and a block — use at least ` +
          `${head + floor + NOTICE_MARGIN} (${hours(NOTICE_MARGIN)} of margin)`,
      },
    ]
  }
  return []
}

/** Luna is the unit; NIM is for the human reading the dry run. */
export function formatLuna(amount: bigint): string {
  const whole = amount / LUNA_PER_NIM
  const fraction = amount % LUNA_PER_NIM
  const nim =
    fraction === 0n ? `${whole}` : `${whole}.${fraction.toString().padStart(5, '0').replace(/0+$/, '')}`
  return `${amount} luna (${nim} NIM)`
}

/**
 * §11.5 rule 2 asks for a threshold "well above zero, sized so that topping up
 * is routine rather than an incident". `ADMIN_ADDRESS` has no income and every
 * message it sends costs `DUST_VALUE` plus a fee of 0, so 1 NIM funds 100,000
 * messages — a lifetime of `P`, `U` and `A`. The floor is a tenth of that
 * (Kike, 2026-09-19: it was 10 NIM, which warned on an address holding
 * decades of headroom): still ten thousand messages, and it only warns.
 */
export const ADMIN_MIN_BALANCE = LUNA_PER_NIM / 10n

/**
 * §11.5 rule 1's read. `getAccountByAddress` answers `balance: 0` for an
 * address the node has never seen rather than erroring, which is exactly the
 * case this exists to catch: an unfunded sender's transaction is accepted by
 * the RPC, returns a hash, and is never mined (§5.3).
 */
export async function readBalance(rpc: AdminRpc, address: Address): Promise<bigint> {
  const account = await rpc.call<{ balance?: unknown }>('getAccountByAddress', [address])
  const balance = account?.balance
  if (typeof balance !== 'number' || !Number.isInteger(balance) || balance < 0) {
    throw new AdminError(
      `getAccountByAddress(${formatAddress(address)}) returned balance ${JSON.stringify(balance)} — expected a whole number of luna`,
    )
  }
  return BigInt(balance)
}
