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
 */

import { encodeUnreserve, parseAddress, type Address, type NnsConfig } from '@nns/core'

/**
 * The slice of the RPC surface this command touches. `@nns/indexer`'s
 * `RpcClient` satisfies it structurally; tests satisfy it with a recorder.
 */
export interface AdminRpc {
  call<T>(method: string, params?: readonly unknown[]): Promise<T>
}

/** Wrong argv shape — the caller prints usage and exits 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError'
}

export interface UnreserveParams {
  readonly name: string
  readonly effectiveHeight: number
  /** `null` releases the name; an address awards it (r17). */
  readonly recipient: Address | null
}

export interface UnreserveOutcome {
  readonly kind: 'release' | 'award'
  /** Where the transaction went: `PROTOCOL_ADDRESS` or the awardee. */
  readonly recipient: Address
  readonly validityStartHeight: number
  readonly hash: string
}

/** `u <name> <effective-height> [recipient]` — omit the recipient to release. */
export function parseUnreserveArgs(argv: readonly string[]): UnreserveParams {
  const [name, height, recipient, ...rest] = argv
  if (name === undefined || height === undefined || rest.length > 0) {
    throw new UsageError('u takes a name, an effective height, and optionally an awardee address')
  }
  if (!/^\d+$/.test(height) || !Number.isSafeInteger(Number(height))) {
    throw new UsageError(`effective-height must be a non-negative integer, got ${JSON.stringify(height)}`)
  }
  return {
    name,
    effectiveHeight: Number(height),
    recipient: recipient === undefined ? null : parseAddress(recipient),
  }
}

/**
 * Build and broadcast one `U`. Sequence per `docs/rpc-reference.md` §5.2:
 * unlock the admin account, read the head for `validityStartHeight`, send.
 *
 * The builder runs first, with `sender` supplied, so everything
 * client-preventable — bad name, `BURN_ADDRESS`, and an award to the admin
 * address itself, which the network would drop as a silent self-transaction —
 * fails before the node hears anything.
 */
export async function sendUnreserve(
  rpc: AdminRpc,
  config: NnsConfig,
  params: UnreserveParams,
): Promise<UnreserveOutcome> {
  const tx = encodeUnreserve(config, { ...params, sender: config.admin })
  await rpc.call('unlockAccount', [config.admin, null, null])
  const validityStartHeight = await rpc.call<number>('getBlockNumber')
  const hash = await rpc.call<string>('sendBasicTransactionWithData', [
    config.admin,
    tx.recipient,
    tx.data,
    // JSON has no bigint; the value is DUST_VALUE by construction, so the
    // conversion cannot lose precision. fee 0 is accepted (§5.4).
    Number(tx.value),
    0,
    validityStartHeight,
  ])
  return {
    kind: params.recipient === null ? 'release' : 'award',
    recipient: tx.recipient,
    validityStartHeight,
    hash,
  }
}
