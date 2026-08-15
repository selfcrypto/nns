/**
 * What every admin command shares: the RPC slice it talks through, the two
 * error shapes, and the two computations §6 and §11.5 make identical for all
 * of them — a height read as hours from the head, and a sender's balance.
 *
 * Nothing protocol-shaped lives here. A height in hours is a display rule
 * (Albatross targets one block per second) and a balance precheck is §11.5's
 * operational requirement, not a consensus rule.
 */

import { CONSTANTS, LUNA_PER_NIM, formatAddress, type Address } from '@nns/core'

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

/** Albatross targets one block per second — `GOVERNANCE_DELAY`'s 43,200 blocks read as ~12 h. */
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
 * Margin this CLI demands *above* `GOVERNANCE_DELAY`, in blocks (~1 h).
 *
 * Notice is the one §10.6 bound that cannot be checked exactly. The reducer
 * measures it from the block the message **lands in** (§6 `P`); this process
 * only knows the head it planned against, and an `effective_height` at exactly
 * `head + GOVERNANCE_DELAY` therefore forfeits unless the message is mined in
 * the very next block. §6 `P` says clients MUST compute it "with margin above
 * `GOVERNANCE_DELAY`, never from the exact minimum"; this is that margin. It
 * is client policy rather than a protocol rule, which is why it lives here and
 * not in `core`, and it is shared by `p` and `u` so the two can never drift.
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

/**
 * §6 `P`/`U` notice, checked the one way both commands must check it. Empty
 * when the notice clears `GOVERNANCE_DELAY` with the margin.
 *
 * `type` is the message letter, so the refusal names the clause the operator
 * will be reading.
 */
export function noticeChecks(type: 'P' | 'U', effectiveHeight: number, head: number): AdminCheck[] {
  const notice = effectiveHeight - head
  const floor = CONSTANTS.GOVERNANCE_DELAY
  if (notice < floor) {
    return [
      {
        severity: 'refuse',
        message:
          `§6 ${type} notice: effective height is ${notice} blocks from head ${head}, under GOVERNANCE_DELAY ` +
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
          `§6 ${type} notice: effective height is ${notice} blocks from head ${head}, which clears ` +
          `GOVERNANCE_DELAY by ${notice - floor} blocks. Notice is measured from the block this lands in, not ` +
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
 * message it sends costs `DUST_VALUE` plus a fee of 0, so any threshold at all
 * is thousands of messages of headroom; this one also survives a future
 * regime where a fee is charged.
 */
export const ADMIN_MIN_BALANCE = 10n * LUNA_PER_NIM

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
