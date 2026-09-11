/**
 * The payment link: `#/pay/<name>?amount=25&message=INV-42[&asset=usdt]`.
 *
 * A seller sends one and the payer only presses Pay. Same shape and the same
 * never-throw rule as `lib/referral.ts`, and a separate module for the same
 * reason the router has one: this is parsing, and parsing belongs where it
 * can be tested — the package's Vitest environment is `node`.
 *
 * A link arrives two ways and means the same thing both times: opened from the
 * address bar (`payRequestFromHash`, read once in a render-phase initializer),
 * or **pasted into the recipient field** (`payRequestFromLink`), which is the
 * only route a payer already inside Nimiq Pay has.
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
import { formatRoute, parseRoute } from './route'

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

/** A pasted link: the name it pays and everything it asked for. */
export interface PayLink {
  readonly name: string
  readonly request: PayRequest
}

/**
 * A payment link someone pasted into the recipient field, or `null` for
 * anything else — a typed name reaches this on every keystroke and must come
 * back `null` untouched.
 *
 * This is the only way a link works for a payer already **inside** Nimiq Pay:
 * no app-link association exists between the wallet and this domain, so a link
 * tapped in a chat app opens a browser and never the mini app. Pasting is the
 * route in, and the field the payer already has is where a pasted address goes
 * in every other wallet.
 *
 * The `#` is the whole test: a name can never contain one (§4.1's alphabet),
 * and every shape this app emits or a person retypes carries it — the full
 * `https://host/#/pay/donald?amount=25`, a bare `#/pay/donald`, a `/#/…`
 * copied out of an address bar. The host is not checked, because the bundle
 * is deliberately domain-agnostic (`payLinkFor`) and an independent deployment
 * serving the same app under its own name is a link this app should still read.
 * A path-shaped link is not accepted: nothing here emits one and nginx answers
 * it 404 (`lib/route.ts`).
 */
export function payRequestFromLink(text: string): PayLink | null {
  const trimmed = text.trim()
  const mark = trimmed.indexOf('#')
  if (mark === -1) return null
  const hash = trimmed.slice(mark)
  // `home` as the fallback, so only a hash that genuinely names Pay is read as
  // one — the fallback is what an unparseable hash becomes.
  const route = parseRoute(hash, 'home')
  if (route.tab !== 'pay' || route.param === null) return null
  return { name: route.param, request: payRequestFromHash(hash) }
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
