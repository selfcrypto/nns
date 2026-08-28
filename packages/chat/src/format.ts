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
 * **`@nns/core` is imported for two things: `validateNameSyntax` and
 * `validateLabel`.** A subject is an NNS name or a `label.name` query, so its
 * syntax is §4.1's and §4.4's rule — reading those rules is not participating
 * in the protocol, while copying them would be a second implementation of a
 * protocol rule. Nothing here reaches core's state, the reducer, the log or
 * any root.
 */

import { validateLabel, validateNameSyntax } from '@nns/core'
import { bytesToHex, hexToBytes } from './hex.js'

export const CHAT_PREFIX = 'NC1'
/** The network's measured silent-drop boundary (docs/rpc-reference.md §4). */
export const CHAT_MAX_BYTES = 64
export const CHAT_DUST_LUNA = 1n

/**
 * Message budget in UTF-8 **bytes** for a given subject: 64 − 3 − subject − 1.
 * A dotted subject is the longest one there is — 49 bytes at the limits — and
 * the composer shows what that leaves rather than refusing it.
 */
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

/**
 * A subject is a name, **or a `label.name` query** (docs/app-chat.md §2).
 *
 * The dotted form is what a message to a subdomain is about. §8.6 gives a
 * subdomain no owner and no record — the only address it has is the one its
 * parent's delegate host answered with — so a message about `rico.nns` goes
 * *there*, and the subject has to be able to say `rico.nns`. Naming the parent
 * instead would have addressed a different party (Kike, 2026-08-28): the
 * parent's owner is whoever runs the host, not whoever holds the label.
 *
 * Syntax only, on both halves: §4.1 rule 6 is chain state (an awarded short
 * name is registered and messageable), and §4.4 labels are never reserved.
 */
export function validateChatSubject(subject: string): boolean {
  const dot = subject.indexOf('.')
  if (dot < 0) return validateNameSyntax(subject).ok
  if (subject.indexOf('.', dot + 1) >= 0) return false
  return validateLabel(subject.slice(0, dot)).ok && validateNameSyntax(subject.slice(dot + 1)).ok
}

export function encodeChatPayload(name: string, message: string): ChatEncodeResult {
  if (!validateChatSubject(name)) return { ok: false, reason: 'BAD_NAME' }
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
  if (!validateChatSubject(name)) return null
  if (message.length === 0 || CONTROL.test(message)) return null
  return { name, message }
}
