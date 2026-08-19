/**
 * NC — name-to-owner messages: the wire format. The convention is
 * `docs/app-chat.md`; this package is its only implementation, shared by the
 * app and the chat index so there is exactly one parser. Pure: no I/O.
 *
 * The one rule that keeps it harmless: the prefix is `NC1` and must never
 * become anything starting `NNS1` — that boundary is what keeps every
 * message invisible to every NNS indexer (§7.5), instead of a forfeited,
 * log-spamming `UNKNOWN_TYPE`.
 *
 * **`@nns/core` is imported for one thing: `validateNameSyntax`.** The name in
 * a payload is an NNS name, so its syntax is §4.1's rule — reading that rule
 * is not participating in the protocol, while copying it would be a second
 * implementation of a protocol rule. Nothing here reaches core's state, the
 * reducer, the log or any root.
 */

import { validateNameSyntax } from '@nns/core'
import { bytesToHex, hexToBytes } from './hex.js'

export const CHAT_PREFIX = 'NC1'
/** The network's measured silent-drop boundary (docs/rpc-reference.md §4). */
export const CHAT_MAX_BYTES = 64
export const CHAT_DUST_LUNA = 1n

/** Message budget in UTF-8 **bytes** for a given name: 64 − 3 − name − 1. */
export function chatByteBudget(name: string): number {
  return CHAT_MAX_BYTES - CHAT_PREFIX.length - name.length - 1
}

export function messageBytes(message: string): number {
  return new TextEncoder().encode(message).length
}

export type ChatEncodeFailure = 'BAD_NAME' | 'EMPTY_MESSAGE' | 'CONTROL_CHARS' | 'OVER_BUDGET'

export type ChatEncodeResult =
  | { readonly ok: true; readonly dataHex: string }
  | { readonly ok: false; readonly reason: ChatEncodeFailure }

// eslint-disable-next-line no-control-regex -- the point is to refuse them
const CONTROL = /[\u0000-\u001f\u007f]/

export function encodeChatPayload(name: string, message: string): ChatEncodeResult {
  // Syntax, not the full rule set: awarded short names are registered and
  // messageable, so the reserved floor must not apply here.
  if (!validateNameSyntax(name).ok) return { ok: false, reason: 'BAD_NAME' }
  if (message.length === 0) return { ok: false, reason: 'EMPTY_MESSAGE' }
  if (CONTROL.test(message)) return { ok: false, reason: 'CONTROL_CHARS' }
  const bytes = new TextEncoder().encode(`${CHAT_PREFIX}${name}|${message}`)
  if (bytes.length > CHAT_MAX_BYTES) return { ok: false, reason: 'OVER_BUDGET' }
  return { ok: true, dataHex: bytesToHex(bytes) }
}

export interface ChatPayload {
  readonly name: string
  readonly message: string
}

/** `null` for anything that is not a well-formed NC1 payload — never a throw. */
export function parseChatPayload(dataHex: string): ChatPayload | null {
  const bytes = hexToBytes(dataHex)
  if (bytes === null || bytes.length > CHAT_MAX_BYTES) return null
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  if (!text.startsWith(CHAT_PREFIX)) return null
  const rest = text.slice(CHAT_PREFIX.length)
  const separator = rest.indexOf('|')
  if (separator === -1) return null
  const name = rest.slice(0, separator)
  const message = rest.slice(separator + 1)
  if (!validateNameSyntax(name).ok) return null
  if (message.length === 0 || CONTROL.test(message)) return null
  return { name, message }
}
