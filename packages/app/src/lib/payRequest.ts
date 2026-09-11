/**
 * The payment link: `#/pay/<name>?amount=25&message=INV-42[&asset=usdt]`.
 *
 * A seller sends one and the payer only presses Pay. Same shape and the same
 * never-throw rule as `lib/referral.ts`, and a separate module for the same
 * reason the router has one: this is parsing, and parsing belongs where it
 * can be tested — the package's Vitest environment is `node`.
 *
 * Nothing here validates an amount. The text goes into the field as typed and
 * Pay's own check judges it, so `parseNimAmount` stays the one NIM parser and
 * `parseUsdtAmount` the one USDT parser. A message is the exception, because
 * its two rules are protocol rules and both fail silently on-chain (below).
 *
 * The query is not part of the route (`lib/route.ts`), and Pay rewrites its
 * own hash through `formatRoute` as soon as the first query settles — so a
 * link's parameters are read once, in a render-phase initializer, and are
 * gone from the address bar a moment later. That is the honest outcome: once
 * the payer edits the amount, a URL still naming the old one would describe a
 * payment nobody is making.
 */

import { CONSTANTS } from '@nns/core'
import { formatRoute } from './route'

const AMOUNT = 'amount'
const MESSAGE = 'message'
const ASSET = 'asset'

/** Which asset the link asks for. `null` is unsaid, and unsaid is NIM. */
export type PayAsset = 'nim' | 'usdt'

export interface PayRequest {
  /** The amount as the link wrote it — the field's own check judges it. */
  readonly amount: string | null
  readonly message: string | null
  readonly asset: PayAsset | null
}

const NOTHING: PayRequest = { amount: null, message: null, asset: null }

/**
 * Why a reference cannot be sent. Both are silent failures on-chain, which is
 * why they are refused here rather than discovered afterwards:
 *
 * - `OVER_BUDGET` — §5.1's 64 bytes. Measured on mainnet: a longer payload is
 *   accepted by the RPC, returns a hash, and never appears in a block.
 * - `RESERVED_PREFIX` — §7.5. Every indexer reads a transaction whose data
 *   begins with `NNS1` as a protocol message, so a reference starting that
 *   way would be logged as a forfeited one.
 */
export type PayMessageFault = 'OVER_BUDGET' | 'RESERVED_PREFIX'

/** UTF-8 bytes, the unit the ceiling is measured in — an accented character is two. */
export function payMessageBytes(message: string): number {
  return new TextEncoder().encode(message).length
}

/** `null` when the reference can be sent. An empty message is a plain transfer, and fine. */
export function payMessageFault(message: string): PayMessageFault | null {
  // Exact case, because that is what every reader matches (`core`'s codec):
  // a lowercase `nns1` is invisible to every indexer, so refusing it would be
  // a rule with no mechanism behind it.
  if (message.startsWith(CONSTANTS.PROTOCOL_ID)) return 'RESERVED_PREFIX'
  if (payMessageBytes(message) > CONSTANTS.MAX_DATA_BYTES) return 'OVER_BUDGET'
  return null
}

function asset(value: string | null): PayAsset | null {
  const asked = value?.trim().toLowerCase()
  return asked === 'nim' || asked === 'usdt' ? asked : null
}

/**
 * The request a `#/pay/…` hash carries. Anything unparseable is `null`, never
 * an error: a mistyped link must still open the screen.
 */
export function payRequestFromHash(hash: string): PayRequest {
  if (!hash.includes('?')) return NOTHING
  let query: URLSearchParams
  try {
    query = new URLSearchParams(hash.slice(hash.indexOf('?')))
  } catch {
    return NOTHING
  }
  const message = query.get(MESSAGE)
  return {
    amount: query.get(AMOUNT)?.trim() || null,
    message: message === null || message.trim() === '' ? null : message.trim(),
    asset: asset(query.get(ASSET)),
  }
}

/**
 * The link a seller shares: this app's own origin and `#/pay/<name>`,
 * domain-agnostic like `shareLinkFor`, with the hash built by `formatRoute`
 * so the name is encoded the one way. Only the parts asked for are written —
 * `asset` never for NIM, which is what an absent one already means.
 */
export function payLinkFor(
  name: string,
  request: PayRequest,
  base: string = globalThis.document?.baseURI ?? '',
): string {
  const query = new URLSearchParams()
  if (request.amount !== null && request.amount.trim() !== '') query.set(AMOUNT, request.amount.trim())
  if (request.message !== null && request.message !== '') query.set(MESSAGE, request.message)
  if (request.asset === 'usdt') query.set(ASSET, 'usdt')
  const tail = query.toString() === '' ? '' : `?${query.toString()}`
  const route = `${formatRoute({ tab: 'pay', param: name })}${tail}`
  try {
    return `${new URL(base).origin}/${route}`
  } catch {
    return `/${route}`
  }
}
