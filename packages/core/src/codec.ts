/**
 * Wire format — spec §5 and §6.
 *
 * ```
 * NNS1 <type> <payload>
 * ```
 *
 * Bytes 0–3 are `NNS1`, byte 4 is one uppercase type character, and bytes 5+
 * are a type-specific payload, `|`-delimited where multi-field. Everything is
 * text-safe ASCII; raw binary is never used, so a message is readable in a
 * block explorer.
 *
 * ## Builders are strict, `parse` is tolerant
 *
 * A builder **throws** rather than emit a message the chain would drop: over
 * 64 bytes is accepted by the RPC, returns a transaction hash, and then never
 * lands in a block (§5.1, verified on mainnet 2026-08-06). Silent on the wire
 * means loud here.
 *
 * `parse` reads what the chain actually contains, so it splits fields without
 * judging them. A `G` naming an invalid name parses fine and is rejected by
 * the reducer with a §7.4 verdict — it has to, because a rejected message
 * still earns a log line (§7.6).
 *
 * No builder takes a config since the launch freeze: every §3 routing
 * address is a constant, so the params object is the whole call shape.
 */

import { type Address, addressEquals, parseAddress } from './address.js'
import { CONSTANTS } from './constants.js'
import { isValidRef, validateHost, validateNameSyntax } from './name.js'

/** §3's canonical burn address, parsed once. The `F` recipient is not a config value. */
export const BURN_ADDRESS: Address = parseAddress(CONSTANTS.BURN_ADDRESS)

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * `'R'` is absent deliberately. It carried the recovery address through r19;
 * r20 removed the mechanism, and the letter is **not** reserved — `NNS1R…`
 * parses as `UNKNOWN_TYPE` and forfeits like any unrecognised type (§7.4).
 */
export const MESSAGE_TYPES = ['G', 'S', 'X', 'D', 'K', 'N', 'O', 'B', 'M', 'A', 'P', 'U', 'F'] as const

export type MessageType = (typeof MESSAGE_TYPES)[number]

/**
 * A parsed message. Payload fields only — the transaction's sender, recipient
 * and value live on the transaction, and the reducer combines the two. `S` in
 * particular carries no target in its payload: the recipient *is* the
 * target, which is what puts the destination address in Nimiq Pay's own
 * confirmation dialog (§5.3).
 */
export type Message =
  | { readonly type: 'G'; readonly name: string; readonly ref: string | null }
  | { readonly type: 'S'; readonly name: string }
  | { readonly type: 'X'; readonly name: string }
  | { readonly type: 'D'; readonly name: string; readonly host: string }
  | { readonly type: 'K'; readonly name: string }
  | { readonly type: 'N'; readonly name: string }
  | { readonly type: 'O'; readonly name: string; readonly price: bigint }
  | { readonly type: 'B'; readonly name: string }
  | { readonly type: 'M'; readonly height: number; readonly txIndex: number }
  | { readonly type: 'A'; readonly name: string; readonly reserve: bigint; readonly endHeight: number }
  | {
      readonly type: 'P'
      readonly feeStandard: bigint
      readonly feeLong: bigint
      readonly commissionBp: bigint
      readonly effectiveHeight: number
    }
  | { readonly type: 'U'; readonly name: string }
  | { readonly type: 'F' }

export type ParseFailure =
  /** Not valid lowercase hex. The RPC returns hex in both directions (§5.1). */
  | 'NOT_HEX'
  /** Missing the `NNS1` prefix. §7.5 discards these before anything else. */
  | 'NOT_NNS1'
  /** Over `MAX_DATA_BYTES`. Cannot reach a block, so this is defensive (§5.1). */
  | 'OVER_LENGTH'
  /** A type character outside {@link MESSAGE_TYPES} (§5.2). */
  | 'UNKNOWN_TYPE'
  /** Right prefix and a known type, but the payload does not fit its shape. */
  | 'MALFORMED_PAYLOAD'

export type ParseResult =
  | { readonly ok: true; readonly message: Message }
  | { readonly ok: false; readonly reason: ParseFailure }

/** The three transaction fields a builder produces. `data` is lowercase hex. */
export interface BuiltTransaction {
  readonly recipient: Address
  readonly value: bigint
  readonly data: string
}

export class CodecError extends Error {
  override readonly name = 'CodecError'
}

const fail = (message: string): never => {
  throw new CodecError(message)
}

const bad = (reason: ParseFailure): ParseResult => ({ ok: false, reason })
const good = (message: Message): ParseResult => ({ ok: true, message })

// ── ASCII and hex ───────────────────────────────────────────────────────────

/**
 * Encoded by hand rather than with `TextEncoder` so the ASCII-only rule of
 * §5.2 is enforced instead of assumed: a non-ASCII character would otherwise
 * become two or three UTF-8 bytes and silently overrun the budget.
 */
function asciiToHex(text: string): string {
  let hex = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code > 0x7f) fail(`message payload must be ASCII (§5.2), got U+${code.toString(16).toUpperCase()}`)
    hex += code.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * One character per byte, so no information is lost and no byte sequence can
 * be reinterpreted. Bytes above 0x7f become characters that every field
 * validator rejects, which is the intended outcome.
 */
function hexToText(hex: string): string | null {
  if (hex.length % 2 !== 0) return null
  let text = ''
  for (let i = 0; i < hex.length; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16)
    if (Number.isNaN(byte)) return null
    text += String.fromCharCode(byte)
  }
  return text
}

const HEX = /^[0-9a-fA-F]*$/

// ── Canonical numeric fields ────────────────────────────────────────────────

/**
 * Exactly one decimal representation per value: no sign, no leading zeros, no
 * whitespace, no empty string.
 *
 * §5.2 leaves the numeric encoding unstated. Two implementations disagreeing
 * about whether `0042` is a valid height would accept different sets of
 * messages and diverge — so a canonical form is chosen here and flagged in
 * `docs/decisions.md` as needing spec ratification.
 */
const CANONICAL_UINT = /^(?:0|[1-9][0-9]*)$/

function parseHeight(field: string): number | null {
  if (!CANONICAL_UINT.test(field)) return null
  const value = Number(field)
  return Number.isSafeInteger(value) ? value : null
}

function parseLuna(field: string): bigint | null {
  return CANONICAL_UINT.test(field) ? BigInt(field) : null
}

const formatHeight = (height: number): string => {
  if (!Number.isSafeInteger(height) || height < 0) fail(`height must be a non-negative safe integer, got ${height}`)
  return String(height)
}

const formatLuna = (amount: bigint): string => {
  if (amount < 0n) fail(`amount must not be negative, got ${amount}`)
  return amount.toString(10)
}

// ── parse ───────────────────────────────────────────────────────────────────

/**
 * Read a transaction's `recipientData` (hex, as the RPC returns it) into a
 * message.
 *
 * The three §5.2 "ignored" cases and the malformed case are distinguished so
 * the log can record *why*, but the reducer gives all four the same §7.4
 * verdict. `NOT_NNS1` is the one that never earns a log line at all — §7.5
 * discards it before a message is even parsed.
 */
export function parse(recipientDataHex: string): ParseResult {
  if (!HEX.test(recipientDataHex)) return bad('NOT_HEX')

  const text = hexToText(recipientDataHex.toLowerCase())
  if (text === null) return bad('NOT_HEX')

  if (!text.startsWith(CONSTANTS.PROTOCOL_ID)) return bad('NOT_NNS1')
  if (text.length > CONSTANTS.MAX_DATA_BYTES) return bad('OVER_LENGTH')

  const raw = text.charAt(CONSTANTS.PROTOCOL_ID.length)
  const payload = text.slice(CONSTANTS.PROTOCOL_ID.length + 1)

  if (!(MESSAGE_TYPES as readonly string[]).includes(raw)) return bad('UNKNOWN_TYPE')
  const type = raw as MessageType

  switch (type) {
    case 'G': {
      // Split on the FIRST pipe only, and never let the referrer reject the
      // message: §6 `G` requires an unknown or malformed ref to be recorded as
      // absent, because accounting must not be able to reject a paid
      // registration.
      const at = payload.indexOf('|')
      const name = at < 0 ? payload : payload.slice(0, at)
      const rawRef = at < 0 ? null : payload.slice(at + 1)
      if (name.length === 0) return bad('MALFORMED_PAYLOAD')
      return good({ type: 'G', name, ref: rawRef !== null && isValidRef(rawRef) ? rawRef : null })
    }

    case 'S':
    case 'X':
    case 'K':
    case 'N':
    case 'B': {
      if (payload.length === 0 || payload.includes('|')) return bad('MALFORMED_PAYLOAD')
      return good({ type, name: payload })
    }

    case 'D': {
      const fields = payload.split('|')
      // Exactly one pipe. An empty host is valid and clears the delegation,
      // so `NNS1Dname|` parses; `NNS1Dname` does not.
      if (fields.length !== 2) return bad('MALFORMED_PAYLOAD')
      const [name, host] = fields as [string, string]
      if (name.length === 0) return bad('MALFORMED_PAYLOAD')
      return good({ type: 'D', name, host })
    }

    case 'O': {
      const fields = payload.split('|')
      if (fields.length !== 2) return bad('MALFORMED_PAYLOAD')
      const [name, priceField] = fields as [string, string]
      const price = parseLuna(priceField)
      if (name.length === 0 || price === null) return bad('MALFORMED_PAYLOAD')
      return good({ type: 'O', name, price })
    }

    case 'M': {
      const fields = payload.split('|')
      if (fields.length !== 2) return bad('MALFORMED_PAYLOAD')
      const [heightField, indexField] = fields as [string, string]
      const height = parseHeight(heightField)
      const txIndex = parseHeight(indexField)
      if (height === null || txIndex === null) return bad('MALFORMED_PAYLOAD')
      return good({ type: 'M', height, txIndex })
    }

    case 'A': {
      const fields = payload.split('|')
      if (fields.length !== 3) return bad('MALFORMED_PAYLOAD')
      const [name, reserveField, endField] = fields as [string, string, string]
      const reserve = parseLuna(reserveField)
      const endHeight = parseHeight(endField)
      if (name.length === 0 || reserve === null || endHeight === null) return bad('MALFORMED_PAYLOAD')
      return good({ type: 'A', name, reserve, endHeight })
    }

    case 'P': {
      const fields = payload.split('|')
      if (fields.length !== 4) return bad('MALFORMED_PAYLOAD')
      const [standardField, longField, commissionField, effectiveField] = fields as [string, string, string, string]
      const feeStandard = parseLuna(standardField)
      const feeLong = parseLuna(longField)
      const commissionBp = parseLuna(commissionField)
      const effectiveHeight = parseHeight(effectiveField)
      if (feeStandard === null || feeLong === null || commissionBp === null || effectiveHeight === null) {
        return bad('MALFORMED_PAYLOAD')
      }
      return good({ type: 'P', feeStandard, feeLong, commissionBp, effectiveHeight })
    }

    case 'U': {
      // One field since r22: a `U` executes in the block it lands in and
      // carries no height. An r21-format `NNS1U<name>|<effective_height>`
      // therefore splits into two and is MALFORMED_PAYLOAD — deliberately, so
      // an old client's message fails loudly rather than releasing a name on
      // a height nothing reads.
      if (payload.includes('|')) return bad('MALFORMED_PAYLOAD')
      if (payload.length === 0) return bad('MALFORMED_PAYLOAD')
      return good({ type: 'U', name: payload })
    }

    case 'F': {
      // `NNS1F` is the whole message — 5 bytes, no payload.
      if (payload.length !== 0) return bad('MALFORMED_PAYLOAD')
      return good({ type: 'F' })
    }
  }
}

// ── Builders ────────────────────────────────────────────────────────────────

/**
 * Optional sender. When supplied, the builder refuses to produce a
 * self-transaction: Nimiq rejects those *silently* — the RPC accepts the
 * transaction, returns a hash, and the network drops it with no error surfaced
 * anywhere (§5.3). Supplying it is the only way to catch that before broadcast.
 */
export interface SenderOption {
  readonly sender?: Address
}

function build(
  type: MessageType,
  payload: string,
  recipient: Address,
  value: bigint,
  sender: Address | undefined,
  maxBytes: number = CONSTANTS.MAX_DATA_BYTES,
): BuiltTransaction {
  const text = `${CONSTANTS.PROTOCOL_ID}${type}${payload}`
  if (text.length > maxBytes) {
    fail(
      `${type} message is ${text.length} bytes, over the ${maxBytes}-byte limit — ` +
        'the RPC would accept it, return a hash, and the network would silently drop it (§5.1)',
    )
  }
  if (value <= 0n) fail(`value must be positive; the network rejects a value of 0 (§5.4)`)
  if (sender !== undefined && addressEquals(sender, recipient)) {
    fail('sender and recipient must differ — Nimiq drops self-transactions silently (§5.3)')
  }
  return Object.freeze({ recipient, value, data: asciiToHex(text) })
}

/**
 * §3 `MIN_PRICE`, enforced on the write side. Below the floor the reducer
 * forfeits the message (§6 `O`), which §7.4 classes as client-preventable —
 * this is the client preventing it.
 */
function requireAtLeastMinPrice(what: string, amount: bigint, floor: bigint): void {
  if (amount < floor) {
    fail(`${what} ${amount} is below MIN_PRICE (${floor} luna) — the message would forfeit (§6 O, §6 A)`)
  }
}

/**
 * Names carried in a payload must be syntactically valid and pipe-free:
 * §4.1 rules 1–5 without the floor, which is what `validateNameSyntax` is.
 * Reservation is deliberately not checked — it is not a builder error —
 * whether a name is reserved is chain state the builder cannot see (§4.1's
 * floor included: a released or awarded short name is a normal name, and
 * every owner operation must be encodable for it), so reservation is left to
 * the reducer. TOO_SHORT still fails here: a short name failing rules 2–5 is
 * on neither membership route and no message may carry it.
 */
function requireName(name: string): string {
  const check = validateNameSyntax(name)
  if (!check.ok) fail(`invalid name ${JSON.stringify(name)}: ${check.reason} (§4.1)`)
  return name
}

/** `G` — Register (§6). To `TREASURY_ADDRESS`, carrying the fee. */
export function encodeRegister(
  params: { name: string; ref?: string | undefined; fee: bigint } & SenderOption,
): BuiltTransaction {
  // Reservation is deliberately NOT checked here. `CONSTANTS.RESERVED_NAMES`
  // is the static published list, but whether a name is *registrable* is chain
  // state: a fired `U` release makes it AVAILABLE (§7.3) — short names
  // included, since §4.1's floor lifts with the release — and the builder
  // cannot see `state.unreserved`. Rejecting on the list alone would refuse
  // registrations the reducer accepts. A still-reserved `G` forfeits (§7.4).
  const name = requireName(params.name)
  if (params.ref !== undefined && !isValidRef(params.ref)) {
    fail(`invalid ref ${JSON.stringify(params.ref)} — 1…${CONSTANTS.MAX_REF_LEN} chars from a-z, 0-9, - (§6 G)`)
  }
  const payload = params.ref === undefined ? name : `${name}|${params.ref}`
  return build('G', payload, CONSTANTS.TREASURY_ADDRESS, params.fee, params.sender)
}

/**
 * `S` — Set resolution target (§6). To the new target, or to
 * `PROTOCOL_ADDRESS` as the §5.3 sentinel meaning "reset the target to the
 * owner's own address" — which cannot be expressed as a self-transaction.
 */
export function encodeSetTarget(
  params: { name: string; target: Address | null } & SenderOption,
): BuiltTransaction {
  const name = requireName(params.name)
  const recipient = params.target ?? CONSTANTS.PROTOCOL_ADDRESS
  return build('S', name, recipient, CONSTANTS.DUST_VALUE, params.sender)
}

/** `X` — Transfer ownership (§6). To the new owner. */
export function encodeTransfer(
  params: { name: string; newOwner: Address } & SenderOption,
): BuiltTransaction {
  const name = requireName(params.name)
  return build('X', name, params.newOwner, CONSTANTS.DUST_VALUE, params.sender)
}

/**
 * `D` — Set delegate resolver (§6). An empty host clears the delegation.
 *
 * Held to `MAX_DELEGATE_MESSAGE_BYTES` rather than the global ceiling: `D` is
 * the largest message in the protocol, and §6 keeps its margin the same as
 * everything else.
 */
export function encodeDelegate(
  params: { name: string; host: string } & SenderOption,
): BuiltTransaction {
  const name = requireName(params.name)
  const host = validateHost(params.host)
  if (!host.ok) fail(`invalid delegate host ${JSON.stringify(params.host)}: ${host.reason} (§6 D)`)
  return build(
    'D',
    `${name}|${params.host}`,
    CONSTANTS.PROTOCOL_ADDRESS,
    CONSTANTS.DUST_VALUE,
    params.sender,
    CONSTANTS.MAX_DELEGATE_MESSAGE_BYTES,
  )
}

/** `K` — Cancel (§6). Vetoes a pending `X` or `R`, or withdraws an `O`. */
export function encodeCancel(params: { name: string } & SenderOption): BuiltTransaction {
  return build('K', requireName(params.name), CONSTANTS.PROTOCOL_ADDRESS, CONSTANTS.DUST_VALUE, params.sender)
}

/** `N` — Renew (§6). Anyone may send it; it extends from the current expiry. */
export function encodeRenew(
  params: { name: string; fee: bigint } & SenderOption,
): BuiltTransaction {
  return build('N', requireName(params.name), CONSTANTS.TREASURY_ADDRESS, params.fee, params.sender)
}

/**
 * `O` — Offer (§6). Carries `LISTING_FEE`; the price travels in the payload.
 *
 * `minPrice` is §3's `MIN_PRICE` — `FEE_LONG` as in effect at the height this
 * message will land at (§6 `O`). It is a parameter rather than a constant
 * because it is governed: `constants.ts` holds the launch value, which stops
 * being the floor the moment a `P` moves `FEE_LONG`. Callers read it from the
 * active params (`minPrice(state.prices)`), which they hold already — a client
 * cannot show the seller a listing fee without them.
 */
export function encodeOffer(
  params: { name: string; price: bigint; minPrice: bigint } & SenderOption,
): BuiltTransaction {
  const name = requireName(params.name)
  requireAtLeastMinPrice('O price', params.price, params.minPrice)
  // LISTING_FEE is frozen at zero (§12 item 3) — and the network rejects a
  // `value` of 0 outright (§5.4), so the only sendable encoding of "no listing
  // fee" is DUST_VALUE. Written as a comparison rather than as DUST_VALUE
  // outright: the fee is a constant, not a literal, and a spec revision that
  // moves it must not have to remember this line.
  const value = CONSTANTS.LISTING_FEE > 0n ? CONSTANTS.LISTING_FEE : CONSTANTS.DUST_VALUE
  return build('O', `${name}|${formatLuna(params.price)}`, CONSTANTS.TREASURY_ADDRESS, value, params.sender)
}

/**
 * `B` — Buy (§6). To `MARKETPLACE_ADDRESS`, carrying the price **exactly**.
 *
 * The buyer's wallet dialog shows the marketplace address, not the seller, so
 * the client UI must present the offer's name, price and seller itself (§5.3).
 */
export function encodeBuy(
  params: { name: string; price: bigint } & SenderOption,
): BuiltTransaction {
  return build('B', requireName(params.name), CONSTANTS.MARKETPLACE_ADDRESS, params.price, params.sender)
}

/**
 * `M` — Settlement (§6). Sent by `MARKETPLACE_ADDRESS` or `TREASURY_ADDRESS`
 * to the party being paid or refunded, referencing the settled transaction by
 * its canonical `(height, tx_index)` identity.
 */
export function encodeSettlement(
  params: { height: number; txIndex: number; payee: Address; amount: bigint } & SenderOption,
): BuiltTransaction {
  return build(
    'M',
    `${formatHeight(params.height)}|${formatHeight(params.txIndex)}`,
    params.payee,
    params.amount,
    params.sender,
  )
}

/**
 * `A` — Auction (§6). Opens a bidding window; bids reuse `B`.
 *
 * The reserve carries the same `MIN_PRICE` floor as an `O` price, and for one
 * reason beyond parity: at a token reserve `floor(reserve ×
 * AUCTION_MIN_INCREMENT)` is 0 and the increment rule stops existing.
 */
export function encodeAuction(
  params: { name: string; reserve: bigint; endHeight: number; minPrice: bigint } & SenderOption,
): BuiltTransaction {
  const name = requireName(params.name)
  requireAtLeastMinPrice('A reserve', params.reserve, params.minPrice)
  const payload = `${name}|${formatLuna(params.reserve)}|${formatHeight(params.endHeight)}`
  return build('A', payload, CONSTANTS.PROTOCOL_ADDRESS, CONSTANTS.DUST_VALUE, params.sender)
}

/**
 * `P` — Governance (§6). All three parameters travel together so they can
 * never drift out of order or out of sync. Bounds are §10.6's and are checked
 * by the reducer, independently, in every implementation.
 */
export function encodeGovernance(
  params: {
    feeStandard: bigint
    feeLong: bigint
    commissionBp: bigint
    effectiveHeight: number
  } & SenderOption,
): BuiltTransaction {
  const payload = [
    formatLuna(params.feeStandard),
    formatLuna(params.feeLong),
    formatLuna(params.commissionBp),
    formatHeight(params.effectiveHeight),
  ].join('|')
  return build('P', payload, CONSTANTS.PROTOCOL_ADDRESS, CONSTANTS.DUST_VALUE, params.sender)
}

/**
 * `U` — Unreserve (§6). Takes a name out of `RESERVED_NAMES`; *adding* to the
 * list remains impossible without a new spec version.
 *
 * The recipient is an operand, not a route (r17): `recipient: null` (or
 * omitted) releases the name — the transaction goes to `PROTOCOL_ADDRESS` and
 * the name is `AVAILABLE` — while an address **awards** it, `REGISTERED` to
 * that address with a full term. The payload is identical either way.
 * `BURN_ADDRESS` is refused here because the reducer forfeits it
 * (`INVALID_RECIPIENT`), which §7.4 classes as client-preventable — this is the
 * client preventing it.
 *
 * **No height, since r22.** A `U` takes effect in the block it lands in;
 * `GOVERNANCE_DELAY` is `P`'s alone. A notice window protects parties who can
 * act on the warning, and a `U` has none: an award has no counterparty at all,
 * and the only party a scheduled release warns is a frontrunner, who gets a
 * publicly timed starting gun out of it. Fat-finger protection moved to
 * `packages/admin`'s dry run.
 *
 * The name is validated for syntax but **not** against the reserved set — a
 * `U` names a reserved name by definition, short names included: they are
 * reserved by rule (§4.1), and releasing or awarding them is a designed use.
 */
export function encodeUnreserve(
  params: { name: string; recipient?: Address | null } & SenderOption,
): BuiltTransaction {
  const name = requireName(params.name)
  const awardee = params.recipient ?? null
  if (awardee !== null && addressEquals(awardee, BURN_ADDRESS)) {
    fail('a name may not be awarded to BURN_ADDRESS — the message would forfeit INVALID_RECIPIENT (§6 U)')
  }
  return build('U', name, awardee ?? CONSTANTS.PROTOCOL_ADDRESS, CONSTANTS.DUST_VALUE, params.sender)
}

/**
 * `F` — Burn attestation (§6). Tags a treasury-to-burn transfer so it enters
 * the log and the burn dashboard. No protocol effect.
 */
export function encodeBurn(params: { amount: bigint } & SenderOption): BuiltTransaction {
  return build('F', '', BURN_ADDRESS, params.amount, params.sender)
}
