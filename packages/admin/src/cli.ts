/**
 * What every admin command shares: the RPC slice it talks through, the two
 * error shapes, and the two computations §6 and §11.5 make identical for all
 * of them — a height read as hours from the head, and a sender's balance.
 *
 * Nothing protocol-shaped lives here. A height in hours is a display rule
 * (Albatross targets one block per second) and a balance precheck is §11.5's
 * operational requirement, not a consensus rule.
 */

import { LUNA_PER_NIM, formatAddress, type Address } from '@nns/core'

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
